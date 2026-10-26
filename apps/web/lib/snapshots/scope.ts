import { cashLikeTypes } from "@/lib/ledger/constants";
import type { Account, Group, Scope } from "./types";
export function accountInScope(account: Account, scope: Scope) {
  if (account.isSystem) return false;
  return scope === "cash_like"
    ? account.cashLikeInclusion
    : scope === "financial"
      ? account.financialInclusion
      : cashLikeTypes.includes(account.type);
}
export function groupInScope(group: Group, members: Account[], scope: Scope) {
  return scope === "cash_like"
    ? group.cashLikeInclusion
    : scope === "financial"
      ? group.financialInclusion
      : !group.isSecurity &&
        (!members.length || members.every((account) => cashLikeTypes.includes(account.type)));
}
