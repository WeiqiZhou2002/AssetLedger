import type {
  BankAccount,
  BankClient,
  BankItem,
  BankTransaction,
  Holdings,
  LinkRequest,
  PlaidConfig,
  SyncPage,
} from "@/lib/bank-sync/types";
export const plaidConfig: PlaidConfig = {
  APP_SECRET: "synthetic-plaid-app-secret-at-least-32",
  PLAID_ENABLED: "true",
  PLAID_ENV: "sandbox",
  PLAID_CLIENT_ID: "synthetic-client",
  PLAID_SECRET: "synthetic-secret",
  PLAID_REDIRECT_URI: "",
  PLAID_SYNC_INTERVAL_HOURS: 12,
  PLAID_DAYS_REQUESTED: 90,
};
export const bankAccount = (id = "bank", type = "depository", current = "1000.0000"): BankAccount => ({
  id,
  type,
  name: `Example ${id}`,
  officialName: null,
  mask: "1234",
  subtype: type === "credit" ? "credit card" : "checking",
  currency: "USD",
  current,
  available: null,
  limit: null,
});
export const bankTransaction = (id: string, changes: Partial<BankTransaction> = {}): BankTransaction => ({
  id,
  accountId: "bank",
  amount: "20.0000",
  date: "2026-10-22",
  authorizedDate: "2026-10-21",
  name: "EXAMPLE CAFE",
  merchantName: "Example Cafe",
  originalDescription: null,
  primary: "FOOD_AND_DRINK",
  detailed: "FOOD_AND_DRINK_RESTAURANT",
  pending: false,
  pendingTransactionId: null,
  currency: "USD",
  ...changes,
});
export class FakePlaid implements BankClient {
  accessToken = "access-sandbox-SYNTHETIC-ONLY";
  item: BankItem = {
    id: "item-1",
    institutionId: "ins_synthetic",
    institutionName: "Example Bank",
    products: ["transactions"],
    consentExpiresAt: null,
  };
  accountRows = [bankAccount(), bankAccount("card", "credit", "200.0000")];
  linkRequests: LinkRequest[] = [];
  cursors: (string | null)[] = [];
  removed: string[] = [];
  refreshed = 0;
  page: (cursor: string | null, call: number) => SyncPage | Promise<SyncPage> = () => ({
    accounts: this.accountRows,
    added: [],
    modified: [],
    removed: [],
    nextCursor: "cursor-1",
    hasMore: false,
    updateStatus: "HISTORICAL_UPDATE_COMPLETE",
  });
  holdingsResult: Holdings = { accounts: [], holdings: [] };
  async linkToken(request: LinkRequest) {
    this.linkRequests.push(request);
    return { link_token: "link-sandbox-SYNTHETIC", expiration: "2030-01-01T00:00:00Z" };
  }
  async exchange() {
    return { accessToken: this.accessToken, itemId: this.item.id };
  }
  async accounts() {
    return { accounts: this.accountRows, item: this.item };
  }
  async sync(_token: string, cursor: string | null) {
    this.cursors.push(cursor);
    return this.page(cursor, this.cursors.length);
  }
  async holdings() {
    return this.holdingsResult;
  }
  async refresh() {
    this.refreshed++;
  }
  async remove(token: string) {
    this.removed.push(token);
  }
}
export const plaidFailure = (code: string) => ({
  response: { data: { error_code: code, request_id: "synthetic-request" } },
});
