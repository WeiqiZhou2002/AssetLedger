from decimal import Decimal
from typing import Literal
from pydantic import BaseModel, Field

Direction = Literal[
    "charge", "payment", "refund", "credit", "fee", "interest", "transfer_in", "transfer_out", "unknown"
]


class Entry(BaseModel):
    transaction_date: str | None = None
    posted_date: str | None = None
    description_raw: str
    merchant_normalized: str
    amount_raw: str
    amount: str
    currency: str = "USD"
    direction: Direction
    confidence: Decimal = Decimal("0.95")
    source_page: int
    source_row_text: str
    provider_transaction_id: str | None = None


class Diagnostic(BaseModel):
    kind: str
    page: int | None = None
    count: int | None = None
    severity: Literal["info", "warning"] = "warning"


class TransactionLine(BaseModel):
    page: int
    text: str


class Check(BaseModel):
    kind: str
    expected: str
    actual: str
    matches: bool


class Section(BaseModel):
    name: str
    direction: Direction
    printed_total: str
    parsed_total: str


class Rewards(BaseModel):
    earned: str | None = None
    total: str | None = None
    as_of: str | None = None


class DailyBalance(BaseModel):
    date: str
    balance: str


class Summary(BaseModel):
    previous_balance: str | None = None
    ending_balance: str | None = None
    payments: str | None = None
    credits: str | None = None
    purchases: str | None = None
    deposits: str | None = None
    withdrawals: str | None = None
    fees: str | None = None
    interest: str | None = None
    balance_transfers: str | None = None
    advances: str | None = None
    other_debits: str | None = None
    minimum_payment: str | None = None
    payment_due_date: str | None = None
    rewards: Rewards | None = None
    daily_balances: list[DailyBalance] = Field(default_factory=list)
    sections: list[Section] = Field(default_factory=list)
    checks: list[Check] = Field(default_factory=list)


class StatementResult(BaseModel):
    issuer: str | None = None
    statement_type: Literal["credit_card", "bank", "unknown"] = "unknown"
    account_last4: str | None = None
    statement_start: str | None = None
    statement_end: str | None = None
    currency: str = "USD"
    page_count: int
    parser: str
    parser_version: str = "1.0.0"
    entries: list[Entry] = Field(default_factory=list)
    summary: Summary = Field(default_factory=Summary)
    diagnostics: list[Diagnostic] = Field(default_factory=list)
    transaction_lines: list[TransactionLine] = Field(default_factory=list)
