import { money } from "@/lib/money";
import { maskDigits } from "@/lib/imports/text";
import type { BankTransaction } from "./types";

export function signedPlaidAmount(value: string) {
  return money(value).negated().toFixed(4);
}

export function sanitized(row: BankTransaction) {
  return {
    transactionId: row.id,
    accountId: row.accountId,
    amount: signedPlaidAmount(row.amount),
    postedDate: row.date,
    transactionDate: row.authorizedDate ?? row.date,
    name: maskDigits(row.name),
    description: maskDigits(row.originalDescription ?? row.name),
    merchant: maskDigits(row.merchantName ?? row.name),
    currency: row.currency,
    pending: row.pending,
    primary: row.primary,
    detailed: row.detailed,
  };
}
