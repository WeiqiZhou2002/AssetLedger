import re
from decimal import Decimal
from ..document import Document, MONEY, amount, full_date, masked, money, month_day
from ..models import DailyBalance, Diagnostic, Entry, Section, StatementResult
from .common import check, continuation, evidence, finish

KEY = "usbank_checking"


def detect(doc: Document) -> int:
    return 100 if "Uni-Statement" in doc.text and re.search(r"U\.?S\.?\s*BANK", doc.text, re.I) else 0


def parse(doc: Document) -> StatementResult:
    result = StatementResult(
        issuer="U.S. Bank",
        statement_type="bank",
        page_count=len(doc.pages),
        parser=KEY,
        diagnostics=list(doc.diagnostics),
    )
    header_dates = []
    for line in doc.pages[0]:
        right = line.between(390, 612)
        for value in re.findall(r"[A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}", right):
            parsed = full_date(value)
            if parsed and parsed not in header_dates:
                header_dates.append(parsed)
        match = re.search(r"Account Number\s+(\d[\d -]+)", line.text)
        if match:
            digits = re.sub(r"\D", "", match[1])
            if len(digits) >= 4:
                result.account_last4 = digits[-4:]
    if len(header_dates) >= 2:
        result.statement_start, result.statement_end = sorted(header_dates[:2])
    # Some headers split the number onto a separate line. It is never retained.
    if not result.account_last4:
        for index, line in enumerate(doc.pages[0][:-1]):
            if "Account Number:" in line.text:
                digits = re.sub(r"\D", "", doc.pages[0][index + 1].between(390, 612))
                if len(digits) >= 4:
                    result.account_last4 = digits[-4:]
    values = {}
    in_summary = False
    for line in doc.lines:
        text = line.text
        if text.strip() == "Account Summary":
            in_summary = True
            continue
        if in_summary:
            raw = line.right_amount(190)
            for label, key in [
                ("Beginning Balance on", "previous_balance"),
                ("Deposits / Credits", "deposits"),
                ("Other Withdrawals", "withdrawals"),
                ("Ending Balance on", "ending_balance"),
            ]:
                if label in text and raw:
                    values[key] = (
                        money(raw) if key in ("previous_balance", "ending_balance") else abs(money(raw))
                    )
            if "Ending Balance on" in text or text.strip() in (
                "Deposits / Credits", "Other Withdrawals", "Checks Paid", "Card Withdrawals", "Fees"
            ):
                in_summary = False
    for key, value in values.items():
        setattr(result.summary, key, amount(value))
    section = None
    heading = None
    rows = []
    pending = None
    balances = False
    known_sections = ("Deposits / Credits", "Other Withdrawals", "Checks Paid", "Card Withdrawals", "Fees")
    for line in doc.lines:
        text = line.text.strip()
        if text == "Balance Summary":
            balances = True
            section = None
            pending = None
            continue
        if balances:
            if "Balances only appear" in text:
                balances = False
            for left, right in ((0, 200), (200, 390), (390, 612)):
                part = line.between(left, right)
                matches = list(MONEY.finditer(part))
                day = month_day(part, result.statement_start, result.statement_end)
                if day and matches:
                    result.summary.daily_balances.append(
                        DailyBalance(date=day, balance=amount(money(matches[-1][0])))
                    )
            continue
        if text in known_sections or (
            line.spans and any(span.flags & 16 for span in line.spans) and not MONEY.search(text)
        ):
            heading = text
            if text in known_sections:
                section = text
                pending = None
            continue
        if "Description of Transaction" in text and "Amount" in text:
            section = heading or section or "Transactions"
            pending = None
            continue
        if text.startswith("Total ") and section:
            raw = line.right_amount()
            if raw:
                total = sum((abs(Decimal(row.amount)) for row in rows), Decimal(0))
                direction = (
                    "transfer_in" if "Deposit" in section else "fee" if section == "Fees" else "transfer_out"
                )
                result.summary.sections.append(
                    Section(
                        name=section,
                        direction=direction,
                        printed_total=amount(abs(money(raw))),
                        parsed_total=amount(total),
                    )
                )
                check(result, "section_" + direction, abs(money(raw)), total)
            rows = []
            pending = None
            section = None
            continue
        if not section:
            continue
        day = re.match(r"([A-Za-z]{3})\s+(\d{1,2})(?!\d)", text)
        raw = line.right_amount(440)
        if day and raw:
            posted = month_day(day[0], result.statement_start, result.statement_end)
            # Date and description may occupy one span; strip the date after joining.
            description = re.sub(r"^[A-Za-z]{3}\s+\d{1,2}\s*", "", line.between(0, 400)).strip()
            value = money(raw)
            if "Deposit" not in section and value > 0:
                value = -value
            direction = "transfer_in" if value > 0 else "fee" if section == "Fees" else "transfer_out"
            pending = Entry(
                transaction_date=posted,
                posted_date=posted,
                description_raw=masked(description),
                merchant_normalized=masked(description.upper()),
                amount_raw=raw,
                amount=amount(value),
                direction=direction,
                source_page=line.page,
                source_row_text=masked(text),
            )
            result.entries.append(pending)
            rows.append(pending)
            evidence(result, line.page, text)
        elif pending:
            actual = re.search(r"On (\d{2}/\d{2}/\d{2,4})", text)
            provider = re.search(r"PMT ID\s*=\s*([A-Za-z0-9_-]+)", text)
            if (
                actual
                or provider
                or (
                    line.spans
                    and 50 < line.spans[0].x < 400
                    and line.y < 730
                    and not re.search(r"Account Number|Statement Period|Page \d", text)
                )
            ):
                if actual:
                    pending.transaction_date = full_date(actual[1]) or pending.posted_date
                if provider:
                    pending.provider_transaction_id = provider[1]
                continuation(pending, text)
                evidence(result, line.page, text)
        elif day:
            result.diagnostics.append(
                Diagnostic(kind="unrecognized_transaction_line", page=line.page, count=1)
            )
            evidence(result, line.page, text)
    if "previous_balance" in values and "ending_balance" in values:
        check(
            result,
            "summary_math",
            values["ending_balance"],
            values["previous_balance"]
            + values.get("deposits", Decimal(0))
            - values.get("withdrawals", Decimal(0)),
        )
        for balance in result.summary.daily_balances:
            actual = values["previous_balance"] + sum(
                (
                    Decimal(row.amount)
                    for row in result.entries
                    if row.posted_date and row.posted_date <= balance.date
                ),
                Decimal(0),
            )
            check(result, "daily_balance_" + balance.date, Decimal(balance.balance), actual)
    for key, positive in [("deposits", True), ("withdrawals", False)]:
        if key in values:
            actual = sum(
                (abs(Decimal(row.amount)) for row in result.entries if (Decimal(row.amount) > 0) == positive),
                Decimal(0),
            )
            check(result, key + "_summary", values[key], actual)
    return finish(result)
