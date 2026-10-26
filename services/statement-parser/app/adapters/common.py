from decimal import Decimal
from ..document import amount, masked
from ..models import Check, Diagnostic, Entry, StatementResult, TransactionLine


def evidence(result: StatementResult, page: int, text: str):
    safe = masked(text)[:2000]
    if len(result.transaction_lines) < 10000:
        result.transaction_lines.append(TransactionLine(page=page, text=safe))


def continuation(row: Entry, text: str):
    safe = masked(text)
    row.description_raw = (row.description_raw + " " + safe)[:2000]
    row.source_row_text = (row.source_row_text + "\n" + safe)[:4000]
    row.merchant_normalized = row.description_raw.upper()


def check(result: StatementResult, kind: str, expected: Decimal, actual: Decimal):
    matches = abs(expected - actual) <= Decimal("0.005")
    result.summary.checks.append(
        Check(kind=kind, expected=amount(expected), actual=amount(actual), matches=matches)
    )
    if not matches:
        result.diagnostics.append(Diagnostic(kind=kind + "_mismatch"))


def finish(result: StatementResult):
    ocr_pages = {row.page for row in result.diagnostics if row.kind == "ocr_low_confidence"}
    for row in result.entries:
        if row.source_page in ocr_pages:
            row.confidence = min(row.confidence, Decimal("0.55"))
        if not row.transaction_date or not row.posted_date:
            row.confidence = min(row.confidence, Decimal("0.5"))
    if not result.entries:
        result.diagnostics.append(Diagnostic(kind="no_transactions"))
    return result
