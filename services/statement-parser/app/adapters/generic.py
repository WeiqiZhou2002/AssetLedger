import re
from decimal import Decimal
from ..document import Document, MONEY, amount, full_date, masked, money
from ..models import Diagnostic, Entry, StatementResult
from .common import evidence, finish

KEY = "generic_lines"


def detect(doc: Document) -> int:
    return 1


def parse(doc: Document) -> StatementResult:
    result = StatementResult(page_count=len(doc.pages), parser=KEY, diagnostics=list(doc.diagnostics))
    active = False
    for line in doc.lines:
        text = line.text
        if re.search(r"Transactions|Transaction Detail|Description of Transaction", text, re.I):
            active = True
            continue
        if re.search(r"^(Total|Summary|Important|Account Summary|Ending Balance|Payment Coupon)", text, re.I):
            active = False
        if not active:
            continue
        date_match = re.match(r"(\d{2}/\d{2}/\d{4}|\d{4}-\d{2}-\d{2})\s+", text)
        amounts = list(MONEY.finditer(text))
        if date_match and amounts:
            value = money(amounts[-1][0])
            date = full_date(date_match[1]) or (date_match[1] if "-" in date_match[1] else None)
            description = text[date_match.end() : amounts[-1].start()].strip()
            result.entries.append(
                Entry(
                    transaction_date=date,
                    posted_date=date,
                    description_raw=masked(description),
                    merchant_normalized=masked(description.upper()),
                    amount_raw=amounts[-1][0],
                    amount=amount(value),
                    direction="unknown",
                    confidence=Decimal("0.4"),
                    source_page=line.page,
                    source_row_text=masked(text),
                )
            )
            evidence(result, line.page, text)
        elif re.match(r"\d{1,2}[/-]\d{1,2}", text):
            evidence(result, line.page, text)
            result.diagnostics.append(
                Diagnostic(kind="unrecognized_transaction_line", page=line.page, count=1)
            )
    result.diagnostics.append(Diagnostic(kind="unknown_layout_requires_review"))
    return finish(result)
