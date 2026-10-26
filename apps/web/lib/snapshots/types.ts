import type { AccountType } from "@/lib/ledger/constants";
export type Scope = "cash_like" | "financial" | "global";
export type Account = {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  accountGroupId: string | null;
  cashLikeInclusion: boolean;
  financialInclusion: boolean;
  isSystem: boolean;
  openedOn: string | null;
  closedOn: string | null;
};
export type Group = {
  id: string;
  name: string;
  currency: string;
  cashLikeInclusion: boolean;
  financialInclusion: boolean;
  isSecurity: boolean;
  needsMapping: boolean;
};
