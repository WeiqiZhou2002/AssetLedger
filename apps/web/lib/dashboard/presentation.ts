import { decimal } from "@/lib/money/fx";
import { formatAmount } from "@/lib/ledger/format";

export function formatSpending(value: string, currency: string) {
  const amount = decimal(value);
  return amount.lt(0)
    ? `净退款 ${formatAmount(amount.abs().toFixed(4), currency)}`
    : formatAmount(value, currency);
}
export function formatSpendingChange(current: string, previous: string, currency: string) {
  const change = decimal(current).minus(decimal(previous));
  return change.isZero()
    ? "与上月同期持平"
    : `较上月同期${change.lt(0) ? "减少" : "增加"} ${formatAmount(change.abs().toFixed(4), currency)}`;
}
