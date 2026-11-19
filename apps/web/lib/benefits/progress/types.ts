export type Conditions = {
  minimum_spend?: { amount: string; period: string };
  minimum_nights?: number;
  consecutive_months?: number;
};
export type CreditVersion = {
  effective_from: string | null;
  effective_to: string | null;
  status: string;
  amount: string | null;
  period: string;
  period_years?: number;
  reset_basis: string;
  max_posting_lag_days: number | null;
  cap_excludes_tax?: boolean;
  conditions?: Conditions;
  tracking?: { supported: boolean; reasons: string[] };
  last_verified?: string | null;
};
export type Credit = {
  id: string;
  name: string;
  category?: string;
  family?: string;
  delivery?: string;
  enrollment?: string;
  match: { keywords: string[]; exclude?: string[] };
  versions: CreditVersion[];
};
export type Product = { id: string; name: string; issuer: string; currency: string; credits: Credit[] };
export type Account = {
  currency: string;
  product_id: string | null;
  anniversary: string | null;
  statement_close_day: number | null;
  tracking_start: string | null;
};
export type BenefitEntry = {
  id: string;
  date: string;
  amount: string;
  currency: string;
  description: string | null;
  merchant?: string | null;
  family?: string | null;
  assigned_credit?: string | null;
  assigned_period_start?: string | null;
};
export type Override = {
  credit: string;
  effective_from: string | null;
  amount: string | null;
  disabled: boolean;
};
export type ProgressInput = {
  catalog: Product;
  account: Account;
  overrides: Override[];
  entries: BenefitEntry[];
  as_of: string;
  view_year: number;
};
export type Period = {
  start: string;
  end: string;
  cap: string;
  used: string;
  remaining: string;
  excess: string;
  state: "upcoming" | "unused" | "partial" | "full" | "over";
  entries: string[];
};
export type YearSummary = {
  start: string;
  end: string;
  cap: string;
  used: string;
  expired_unused: string;
  available: string;
  upcoming: string;
  excess: string;
};
export type InstanceMetadata = {
  credit: string;
  name: string;
  category: string | null;
  enrollment: string;
  amount: string | null;
  period: string;
  period_years: number | null;
  reset_basis: string;
  conditions: Conditions | null;
  terms_as_of: string | null;
  latest_entry: BenefitEntry | null;
  entry_details: BenefitEntry[];
};
export type ProgressInstance = InstanceMetadata &
  (
    | {
        status: "ok";
        year: YearSummary;
        periods: Period[];
        current_period: Period | null;
        unplaced: string[];
      }
    | {
        status: "ok";
        eligible: boolean;
        unplaced: string[];
        window: { start: string; end: string; cap: string; used: string; next_eligible_on: string } | null;
        entries: string[];
      }
    | { status: "needs_anniversary" | "needs_statement_day" | "to_verify" | "unsupported"; entries: string[] }
  );
export type InformationalCredit = {
  credit: string;
  name: string;
  amount: string | null;
  period: string;
  period_years: number | null;
  delivery: string;
};
