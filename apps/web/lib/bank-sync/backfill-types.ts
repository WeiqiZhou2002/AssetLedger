export type BackfillAction = "keep" | "recalculate" | "exclude";
export type BackfillState = {
  generation: number;
  target: string;
  accounts: {
    accountId: string;
    action: BackfillAction;
    openings: { id: string; fingerprint: string }[];
  }[];
};
