import re
from decimal import Decimal
from ..document import Document, amount, full_date, infer_date, masked, money
from ..models import Entry, Rewards, Section, StatementResult, Diagnostic
from .common import check, continuation, evidence, finish

KEY = "usbank_credit_card"


def detect(doc: Document) -> int:
    return (
        100
        if re.search(r"U\.?S\.?\s*Bank", doc.text, re.I)
        and "Activity Summary" in doc.text
        and "Account Ending" in doc.text
        else 0
    )


def parse(doc: Document) -> StatementResult:
    result = StatementResult(
        issuer="U.S. Bank",
        statement_type="credit_card",
        page_count=len(doc.pages),
        parser=KEY,
        diagnostics=list(doc.diagnostics),
    )
    period = re.search(
        r"Open Date:\s*(\d{2}/\d{2}/\d{4})\s*\|?\s*Closing Date:\s*(\d{2}/\d{2}/\d{4})", doc.text
    )
    if period:
        result.statement_start, result.statement_end = full_date(period[1]), full_date(period[2])
    last4 = re.search(r"Account Ending in:\s*([#*\d ]+)", doc.text)
    if last4:
        digits = re.sub(r"\D", "", last4[1])
        result.account_last4 = digits[-4:] if len(digits) >= 4 else None
    labels = {
        "Previous Balance": "previous_balance",
        "Payments": "payments",
        "Other Credits": "credits",
        "Purchases": "purchases",
        "Balance Transfers": "balance_transfers",
        "Advances": "advances",
        "Other Debits": "other_debits",
        "Fees Charged": "fees",
        "Interest Charged": "interest",
        "New Balance": "ending_balance",
        "Minimum Payment Due": "minimum_payment",
    }
    values = {}
    for line in doc.pages[0]:
        label = line.between(295, 425)
        value = line.right_amount(425)
        for printed, key in labels.items():
            if label.strip() == printed and value:
                values[key] = abs(money(value))
        due = re.search(r"Payment Due Date\s+(\d{2}/\d{2}/\d{4})", line.text)
        if due:
            result.summary.payment_due_date = full_date(due[1])
        if "Earned This Statement" in line.text:
            match = re.search(r"Earned This Statement\*?\s+([\d,]+)", line.text)
            if match:
                result.summary.rewards = result.summary.rewards or Rewards()
                result.summary.rewards.earned = match[1].replace(",", "")
        match = re.search(r"Total as of (\d{2}/\d{2}/\d{4})\*?\*?\s+([\d,]+)", line.text)
        if match:
            result.summary.rewards = result.summary.rewards or Rewards()
            result.summary.rewards.total = match[2].replace(",", "")
            result.summary.rewards.as_of = full_date(match[1])
    for key, value in values.items():
        setattr(
            result.summary, key, amount(-value if key in ("previous_balance", "ending_balance") else value)
        )
    section = None
    section_rows = []
    pending = None
    for page in doc.pages:
        for line in page:
            text = line.text
            if text.strip() in (
                "Payments and Other Credits",
                "Purchases and Other Debits",
                "Fees",
                "Interest Charged",
            ):
                section = text.strip()
                pending = None
                continue
            if re.search(
                r"^(Important Messages|Points Rewards Summary|Interest Charge Calculation|Payment Information|Account Summary)",
                text,
            ):
                section = None
                pending = None
            if not section:
                continue
            if "TOTAL THIS PERIOD" in text:
                total = line.right_amount()
                if total:
                    parsed = sum((abs(Decimal(row.amount)) for row in section_rows), Decimal("0"))
                    direction = (
                        "credit"
                        if section.startswith("Payments")
                        else "fee"
                        if section == "Fees"
                        else "interest"
                        if section == "Interest Charged"
                        else "charge"
                    )
                    result.summary.sections.append(
                        Section(
                            name=section,
                            direction=direction,
                            printed_total=amount(abs(money(total))),
                            parsed_total=amount(parsed),
                        )
                    )
                    check(result, f"section_{direction}", abs(money(total)), parsed)
                    section_rows = []
                section = None
                pending = None
                continue
            if any(
                label in text
                for label in (
                    "Continued on Next Page",
                    "Cardmember Service",
                    "Page ",
                    "Post Date",
                    "Trans Date",
                    "Transaction Description",
                    "Ref #",
                )
            ):
                pending = None
                continue
            post = re.search(r"\b(\d{2}/\d{2})\b", line.between(60, 100))
            raw = line.right_amount(445)
            if post and raw:
                trans = re.search(r"\b(\d{2}/\d{2})\b", line.between(99, 135))
                description = line.between(160, 445)
                credit = section.startswith("Payments")
                direction = (
                    "payment"
                    if credit and "PAYMENT" in description.upper()
                    else "credit"
                    if credit
                    else "fee"
                    if section == "Fees"
                    else "interest"
                    if section == "Interest Charged"
                    else "charge"
                )
                value = abs(money(raw)) * (1 if credit else -1)
                posted = infer_date(post[1], result.statement_start, result.statement_end)
                pending = Entry(
                    transaction_date=infer_date(trans[1], result.statement_start, result.statement_end)
                    if trans
                    else posted,
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
                section_rows.append(pending)
                evidence(result, line.page, text)
            elif pending and 160 <= min((span.x for span in line.spans), default=0) < 220 and line.y < 730:
                continuation(pending, text)
                evidence(result, line.page, text)
                if "MERCHANDISE/SERVICE RETURN" in text.upper() and Decimal(pending.amount) > 0:
                    pending.direction = "refund"
            elif post:
                result.diagnostics.append(
                    Diagnostic(kind="unrecognized_transaction_line", page=line.page, count=1)
                )
                evidence(result, line.page, text)
    if "ending_balance" in values and "previous_balance" in values:
        calculated = (
            values["previous_balance"]
            - values.get("payments", Decimal(0))
            - values.get("credits", Decimal(0))
        )
        calculated += sum(
            (
                values.get(key, Decimal(0))
                for key in ("purchases", "fees", "interest", "balance_transfers", "advances", "other_debits")
            ),
            Decimal(0),
        )
        check(result, "summary_math", values["ending_balance"], calculated)
    credits = sum(
        (Decimal(row.amount) for row in result.entries if row.direction in ("payment", "refund", "credit")),
        Decimal(0),
    )
    purchases = sum((-Decimal(row.amount) for row in result.entries if row.direction == "charge"), Decimal(0))
    if "payments" in values or "credits" in values:
        check(
            result,
            "credits_summary",
            values.get("payments", Decimal(0)) + values.get("credits", Decimal(0)),
            credits,
        )
    if "purchases" in values:
        check(
            result,
            "purchases_summary",
            values["purchases"] + values.get("other_debits", Decimal(0)),
            purchases,
        )
    return finish(result)
