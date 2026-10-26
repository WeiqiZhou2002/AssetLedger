export type PlaidConfig = {
  APP_SECRET: string;
  PLAID_ENABLED: "true" | "false";
  PLAID_ENV: "sandbox" | "production";
  PLAID_CLIENT_ID: string;
  PLAID_SECRET: string;
  PLAID_REDIRECT_URI: string;
  PLAID_SYNC_INTERVAL_HOURS: number;
  PLAID_DAYS_REQUESTED: number;
  PLAID_HISTORY_START?: string;
};
export type BankAccount = {
  id: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  currency: string | null;
  current: string | null;
  available: string | null;
  limit: string | null;
};
export type BankTransaction = {
  id: string;
  accountId: string;
  amount: string;
  date: string;
  authorizedDate: string | null;
  name: string;
  merchantName: string | null;
  originalDescription: string | null;
  primary: string | null;
  detailed: string | null;
  pending: boolean;
  pendingTransactionId: string | null;
  currency: string | null;
};
export type BankItem = {
  id: string;
  institutionId: string | null;
  institutionName: string | null;
  products: string[];
  consentExpiresAt: string | null;
};
export type SyncPage = {
  accounts: BankAccount[];
  added: BankTransaction[];
  modified: BankTransaction[];
  removed: string[];
  nextCursor: string;
  hasMore: boolean;
  updateStatus: string;
};
export type Holdings = {
  accounts: BankAccount[];
  holdings: { accountId: string; value: string; currency: string | null; cash: boolean }[];
};
export type LinkRequest = {
  user: { client_user_id: string };
  client_name: "Asset Ledger";
  language: "en";
  country_codes: ["US"];
  products?: ("transactions" | "investments")[];
  transactions?: { days_requested: number };
  access_token?: string;
  redirect_uri?: string;
};
export interface BankClient {
  linkToken(request: LinkRequest): Promise<{ link_token: string; expiration: string }>;
  exchange(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
  accounts(accessToken: string): Promise<{ accounts: BankAccount[]; item: BankItem }>;
  sync(accessToken: string, cursor: string | null): Promise<SyncPage>;
  holdings(accessToken: string): Promise<Holdings>;
  refresh(accessToken: string): Promise<void>;
  remove(accessToken: string): Promise<void>;
}
