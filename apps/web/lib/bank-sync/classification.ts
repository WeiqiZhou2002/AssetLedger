import { benefitConfig, detectBenefit } from "@/lib/benefits/config";
import { money } from "@/lib/money";
import type { EntryType } from "@/lib/ledger/constants";
import type { Direction } from "@/lib/imports/types";
import type { BankTransaction } from "./types";
import { isCashAdvanceSpend, isCashDeposit, isTransferLike, isZelle } from "./transfer-config";

function expenseCategory(primary: string, detailed: string) {
  const names: Record<string, string> = {
    FOOD_AND_DRINK: "餐饮",
    GENERAL_MERCHANDISE: "购物",
    TRANSPORTATION: "交通",
    TRAVEL: "旅行",
    ENTERTAINMENT: "娱乐",
    MEDICAL: "医疗健康",
  };
  if (primary === "RENT_AND_UTILITIES")
    return detailed === "RENT_AND_UTILITIES_RENT" ? "住房租金" : "水电网络";
  if (primary === "BANK_FEES") return detailed.includes("INTEREST") ? "利息支出" : "手续费";
  return names[primary] ?? "其他支出";
}
export function classifyTransaction(
  row: BankTransaction,
  accountType: string,
): { direction: Direction; type: EntryType; category: string | null } {
  const positive = money(row.amount).gt(0); // Plaid-positive is money out.
  const primary = row.primary ?? "";
  const detailed = row.detailed ?? "";
  const description = `${row.name} ${row.originalDescription ?? ""}`;
  const fullDescription = `${description} ${row.merchantName ?? ""}`;
  if (accountType === "depository") {
    if (
      isCashAdvanceSpend({
        amount: money(row.amount).negated().toFixed(4),
        accountType: "asset_cash",
        description: fullDescription,
      })
    )
      return { direction: "charge", type: "expense", category: "其他支出" };
    if (
      isCashDeposit({
        amount: money(row.amount).negated().toFixed(4),
        accountType: "asset_cash",
        description: fullDescription,
      })
    )
      return { direction: "transfer_in", type: "income", category: "其他收入" };
    if (isZelle(fullDescription))
      return positive
        ? { direction: "charge", type: "expense", category: "其他支出" }
        : { direction: "transfer_in", type: "income", category: "其他收入" };
  }
  if (accountType === "credit" && money(row.amount).lt(0)) {
    const family = detectBenefit({
      amount: money(row.amount).negated().toFixed(4),
      accountType: "liability_credit_card",
      description: fullDescription,
      primary,
    });
    if (family)
      return {
        direction: "refund",
        type: "refund",
        category: benefitConfig[family].categories[0] ?? "其他支出",
      };
    if (
      isTransferLike({
        amount: money(row.amount).negated().toFixed(4),
        accountType: "liability_credit_card",
        description: fullDescription,
        primary,
      })
    )
      return { direction: "payment", type: "credit_card_payment", category: null };
    return { direction: "refund", type: "refund", category: expenseCategory(primary, detailed) };
  }
  if (accountType === "depository" && money(row.amount).lt(0)) {
    if (/\b(?:payroll|direct[\s-]+dep(?:osit)?|salary|ppd[\s-]+id)\b/i.test(description))
      return { direction: "transfer_in", type: "income", category: "工资" };
    if (primary === "INCOME")
      return {
        direction: "transfer_in",
        type: "income",
        category: detailed.includes("INTEREST") ? "利息收入" : "工资",
      };
    if (primary === "TRANSFER_IN") return { direction: "transfer_in", type: "transfer", category: null };
    if (/\b(?:refund|return)\b/i.test(description))
      return { direction: "refund", type: "refund", category: "其他支出" };
    return { direction: "transfer_in", type: "income", category: "其他收入" };
  }
  if (primary === "LOAN_PAYMENTS" && detailed.includes("CREDIT_CARD"))
    return {
      direction: accountType === "credit" ? "payment" : "transfer_out",
      type: "credit_card_payment",
      category: null,
    };
  if (["TRANSFER_IN", "TRANSFER_OUT"].includes(primary))
    return { direction: positive ? "transfer_out" : "transfer_in", type: "transfer", category: null };
  if (primary === "INCOME" && !positive)
    return {
      direction: "transfer_in",
      type: detailed.includes("INTEREST") ? "interest" : "income",
      category: detailed.includes("INTEREST") ? "利息收入" : "工资",
    };
  if (!positive) return { direction: "refund", type: "refund", category: "其他支出" };
  if (primary === "BANK_FEES")
    return detailed.includes("INTEREST")
      ? { direction: "interest", type: "interest", category: "利息支出" }
      : { direction: "fee", type: "fee", category: "手续费" };
  return { direction: "charge", type: "expense", category: expenseCategory(primary, detailed) };
}
