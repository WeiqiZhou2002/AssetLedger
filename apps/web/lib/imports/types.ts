export const directions = [
  "charge",
  "payment",
  "refund",
  "credit",
  "fee",
  "interest",
  "transfer_in",
  "transfer_out",
  "unknown",
] as const;
export type Direction = (typeof directions)[number];
export type Diagnostic = { kind: string; page?: number; count?: number; severity: "info" | "warning" };
export type TransactionLine = { page: number; text: string };
type TotalsCheck = { kind: string; expected: string; actual: string; matches: boolean };
export type StatementSummary = {
  previous_balance?: string;
  ending_balance?: string;
  payments?: string;
  credits?: string;
  purchases?: string;
  deposits?: string;
  withdrawals?: string;
  fees?: string;
  interest?: string;
  balance_transfers?: string;
  advances?: string;
  other_debits?: string;
  minimum_payment?: string;
  payment_due_date?: string;
  rewards?: { earned?: string; total?: string; as_of?: string };
  daily_balances?: { date: string; balance: string }[];
  sections?: { name: string; direction: Direction; printed_total: string; parsed_total: string }[];
  checks?: TotalsCheck[];
  csv_headers?: string[];
  csv_skip_rows?: number;
  header_signature?: string;
};
export type PairingSuggestion = {
  rowId?: string;
  entryId?: string;
  counterAccountId: string;
  kind: "credit_card_payment";
};
export type DecisionPayload = {
  linkEntryId?: string;
  pairRowId?: string;
  pairEntryId?: string;
  notes?: string;
};
export type CsvMapping = {
  dateColumn: string;
  dateFormat: "MM/DD/YYYY" | "YYYY-MM-DD" | "MM/DD/YY";
  descriptionColumn: string;
  amountColumn?: string;
  debitColumn?: string;
  creditColumn?: string;
  referenceColumn?: string;
  signConvention: "account_signed" | "positive_charge";
  skipRows: number;
};
export type AiConsent = {
  inputHash: string;
  lines: TransactionLine[];
  model: string;
  provider: "Anthropic";
  confirmedAt: string;
};
