import { afterEach, expect, it, vi } from "vitest";
import { plaidConfig } from "./helpers/plaid";
const sdk = vi.hoisted(() => ({
  institutionsGet: vi.fn(),
  linkTokenCreate: vi.fn(),
  accountsGet: vi.fn(),
  transactionsSync: vi.fn(),
  investmentsHoldingsGet: vi.fn(),
  itemPublicTokenExchange: vi.fn(),
  itemRemove: vi.fn(),
  transactionsRefresh: vi.fn(),
  sandboxPublicTokenCreate: vi.fn(),
}));
vi.mock("plaid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("plaid")>()),
  PlaidApi: class {
    constructor() {
      return sdk;
    }
  },
}));
import {
  PlaidClient,
  createSandboxPublicToken,
  plaidError,
  testPlaidCredentials,
} from "@/lib/bank-sync/plaid-client";
const account = {
  account_id: "synthetic",
  name: "Example account 1234567890",
  official_name: null,
  mask: "1234",
  type: "depository",
  subtype: "checking",
  balances: {
    current: 0.1,
    available: null,
    limit: null,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
  },
};
const item = {
  item_id: "synthetic-item",
  institution_id: "ins_synthetic",
  institution_name: "Example",
  products: ["transactions"],
  billed_products: [],
  consent_expiration_time: null,
  error: null,
};
afterEach(() => vi.resetAllMocks());
it("uses the cached accounts endpoint, converts SDK numbers immediately and masks descriptions", async () => {
  sdk.accountsGet.mockResolvedValue({ data: { accounts: [account], item } });
  sdk.transactionsSync.mockResolvedValue({
    data: {
      accounts: [account],
      added: [
        {
          transaction_id: "synthetic-row",
          account_id: "synthetic",
          amount: 0.1,
          date: "2026-10-24",
          authorized_date: null,
          name: "EXAMPLE 1234567890",
          merchant_name: null,
          original_description: "EXAMPLE 1234567890",
          personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_RESTAURANT" },
          pending: false,
          pending_transaction_id: null,
          iso_currency_code: "USD",
          unofficial_currency_code: null,
        },
      ],
      modified: [],
      removed: [],
      next_cursor: "cursor",
      has_more: false,
      transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
    },
  });
  const client = new PlaidClient(plaidConfig);
  const cached = await client.accounts("synthetic-secret-token");
  expect(cached.accounts[0].current).toBe("0.1000");
  expect(cached.accounts[0].name).not.toContain("1234567890");
  const result = await client.sync("synthetic-secret-token", "old-cursor");
  expect(result.added[0].amount).toBe("0.1000");
  expect(result.added[0].originalDescription).toBe("EXAMPLE ******7890");
  expect(sdk.transactionsSync).toHaveBeenCalledWith({
    access_token: "synthetic-secret-token",
    cursor: "old-cursor",
    count: 500,
    options: { include_original_description: true },
  });
});
it("does not invent an ISO currency and surfaces Item errors without error messages or headers", async () => {
  sdk.accountsGet.mockResolvedValueOnce({
    data: {
      accounts: [
        {
          ...account,
          balances: { ...account.balances, iso_currency_code: null, unofficial_currency_code: "BTC" },
        },
      ],
      item,
    },
  });
  const client = new PlaidClient(plaidConfig);
  expect((await client.accounts("secret")).accounts[0].currency).toBeNull();
  sdk.accountsGet.mockResolvedValueOnce({
    data: {
      accounts: [],
      item: {
        ...item,
        error: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "do-not-leak", request_id: "synthetic" },
      },
    },
  });
  try {
    await client.accounts("secret");
    throw new Error("expected failure");
  } catch (error) {
    expect(plaidError(error)).toEqual({ errorCode: "ITEM_LOGIN_REQUIRED", requestId: "synthetic" });
    expect(JSON.stringify(error)).not.toContain("do-not-leak");
  }
});
it("rejects production smoke before SDK calls and builds the documented Sandbox preset", async () => {
  await expect(createSandboxPublicToken({ ...plaidConfig, PLAID_ENV: "production" })).rejects.toThrow(
    "仅限 Sandbox",
  );
  expect(sdk.sandboxPublicTokenCreate).not.toHaveBeenCalled();
  sdk.sandboxPublicTokenCreate.mockResolvedValue({ data: { public_token: "public-sandbox-synthetic" } });
  await createSandboxPublicToken(plaidConfig);
  expect(sdk.sandboxPublicTokenCreate).toHaveBeenCalledWith({
    institution_id: "ins_109508",
    initial_products: ["transactions"],
    options: {
      override_username: "user_transactions_dynamic",
      override_password: "synthetic-only",
      transactions: { days_requested: 90 },
    },
  });
});

it.each(["sandbox", "production"] as const)(
  "tests credentials with the authenticated institutions call in %s",
  async (environment) => {
    sdk.institutionsGet.mockResolvedValue({ data: { institutions: [] } });
    await testPlaidCredentials({ ...plaidConfig, PLAID_ENV: environment, PLAID_ENABLED: "false" });
    expect(sdk.institutionsGet).toHaveBeenCalledWith({ count: 1, offset: 0, country_codes: ["US"] });
    expect(sdk.itemPublicTokenExchange).not.toHaveBeenCalled();
  },
);
