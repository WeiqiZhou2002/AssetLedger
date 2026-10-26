import type { importRows } from "@/db/schema";
import type { AccountType } from "@/lib/ledger/constants";
type ApprovalProblem = { rowId: string; rowIndex: number; reasons: string[] };
type ReviewRow = Pick<
  typeof importRows.$inferSelect,
  | "id"
  | "rowIndex"
  | "decision"
  | "journalEntryId"
  | "linkedEntryId"
  | "decisionPayload"
  | "suggestedEntryType"
  | "suggestedCategoryId"
  | "suggestedCounterAccountId"
  | "transactionDate"
  | "duplicateResolution"
>;
export function approvalProblems(row: ReviewRow): string[] {
  if (row.journalEntryId || row.linkedEntryId || row.decision === "exclude") return [];
  const payload = row.decisionPayload;
  if (payload.linkEntryId || payload.pairEntryId) return [];
  if (row.decision === "link_existing") return ["请选择要关联的已有流水"];
  const reasons: string[] = [];
  if (!row.transactionDate) reasons.push("缺少交易日期");
  if (row.duplicateResolution === "duplicate") reasons.push("重复行须排除或关联");
  if (payload.pairRowId) return reasons;
  const type = row.suggestedEntryType;
  if (!type) reasons.push("缺少交易类型");
  if (type && ["expense", "refund", "fee", "interest", "income"].includes(type) && !row.suggestedCategoryId)
    reasons.push("缺少分类");
  if (
    type &&
    [
      "credit_card_payment",
      "transfer",
      "investment_buy",
      "investment_sell",
      "loan_out",
      "loan_repayment",
      "prepayment",
    ].includes(type) &&
    !row.suggestedCounterAccountId
  )
    reasons.push(type === "credit_card_payment" ? "缺少付款账户" : "缺少对方账户");
  if (type === "balance_adjustment" && !payload.notes?.trim()) reasons.push("缺少调整说明");
  return reasons;
}
export function approvalSelection<T extends ReviewRow>(rows: T[]) {
  const readyRows: T[] = [];
  let incompleteCount = 0;
  for (const row of rows) {
    if (row.journalEntryId || row.linkedEntryId || row.decision === "exclude") continue;
    if (approvalProblems(row).length) incompleteCount++;
    else readyRows.push(row);
  }
  return { readyRows, incompleteCount };
}
export class ApprovalError extends Error {
  constructor(readonly rowErrors: ApprovalProblem[]) {
    super(rowErrors.map((row) => `第 ${row.rowIndex + 1} 行：${row.reasons.join("、")}`).join("；"));
  }
}
export function compatibleStatementAccount(
  statementType: string,
  account: { type: AccountType; isSystem: boolean; isActive: boolean; currency: string },
  selected = false,
  statementCurrency?: string | null,
) {
  if (account.isSystem || (!account.isActive && !selected)) return false;
  if (statementCurrency && account.currency !== statementCurrency) return false;
  if (statementType === "credit_card") return account.type === "liability_credit_card";
  if (statementType === "bank") return ["asset_cash", "asset_brokerage_cash"].includes(account.type);
  return ["liability_credit_card", "asset_cash", "asset_brokerage_cash"].includes(account.type);
}
