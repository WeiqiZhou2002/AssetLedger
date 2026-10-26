import { accountSchema } from "@/lib/ledger/schemas";
import { type AccountType } from "@/lib/ledger/constants";

export const importedAccountSchema = accountSchema.pick({
  name: true,
  type: true,
  currency: true,
  last4: true,
  cashLikeInclusion: true,
  financialInclusion: true,
});

export function uniqueAccountName(name: string, existing: Iterable<string>) {
  const names = new Set(existing);
  const base = name.trim().slice(0, 100);
  let candidate = base;
  for (let suffix = 2; names.has(candidate); suffix++) {
    const ending = ` (${suffix})`;
    candidate = `${base.slice(0, 100 - ending.length)}${ending}`;
  }
  return candidate;
}

export function importedAccountName(institution: string, name: string, mask: string | null) {
  const ending = mask ? ` ${mask}` : "";
  return `${[institution, name]
    .filter(Boolean)
    .join(" ")
    .trim()
    .slice(0, 100 - ending.length)}${ending}`;
}

export function plaidLedgerType(type: string): AccountType | null {
  if (type === "depository") return "asset_cash";
  if (type === "credit") return "liability_credit_card";
  if (type === "loan") return "liability_loan";
  if (type === "investment") return "asset_brokerage_cash";
  return null;
}
