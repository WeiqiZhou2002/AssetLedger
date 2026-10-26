import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
  type AccountBase,
  type Transaction,
  type Item,
  type LinkTokenCreateRequest,
} from "plaid";
import Decimal from "decimal.js";
import { maskDigits } from "@/lib/imports/text";
import { invariant } from "@/lib/ledger/errors";
import type { BankClient, BankAccount, BankTransaction, BankItem, LinkRequest, PlaidConfig } from "./types";
// The SDK exposes JSON numeric fields as JS numbers. Convert once at this boundary;
// all subsequent arithmetic and persisted amounts use decimal strings.
function decimal(value: number | null) {
  if (value === null) return null;
  invariant(Number.isFinite(value), "Plaid 返回无效金额");
  return new Decimal(String(value)).toFixed(4);
}
function currency(iso: string | null, unofficial: string | null) {
  return !unofficial && iso && /^[A-Z]{3}$/.test(iso) ? iso : null;
}
function account(
  row: Pick<AccountBase, "account_id" | "name" | "official_name" | "mask" | "type" | "subtype" | "balances">,
): BankAccount {
  return {
    id: row.account_id,
    name: maskDigits(row.name),
    officialName: row.official_name ? maskDigits(row.official_name) : null,
    mask: row.mask ? row.mask.slice(-4) : null,
    type: row.type,
    subtype: row.subtype,
    currency: currency(row.balances.iso_currency_code, row.balances.unofficial_currency_code),
    current: decimal(row.balances.current),
    available: decimal(row.balances.available),
    limit: decimal(row.balances.limit),
  };
}
function transaction(row: Transaction): BankTransaction {
  return {
    id: row.transaction_id,
    accountId: row.account_id,
    amount: decimal(row.amount)!,
    date: row.date,
    authorizedDate: row.authorized_date ?? null,
    name: maskDigits(row.name),
    merchantName: row.merchant_name ? maskDigits(row.merchant_name) : null,
    originalDescription: row.original_description ? maskDigits(row.original_description) : null,
    primary: row.personal_finance_category?.primary ?? null,
    detailed: row.personal_finance_category?.detailed ?? null,
    pending: row.pending,
    pendingTransactionId: row.pending_transaction_id,
    currency: currency(row.iso_currency_code, row.unofficial_currency_code),
  };
}
function item(row: Item): BankItem {
  return {
    id: row.item_id,
    institutionId: row.institution_id ?? null,
    institutionName: row.institution_name ?? null,
    products: row.products ?? row.consented_products ?? row.billed_products,
    consentExpiresAt: row.consent_expiration_time,
  };
}
function plaidApi(config: PlaidConfig, signal?: AbortSignal) {
  invariant(config.PLAID_ENABLED === "true", "银行连接未启用", 404);
  invariant(config.PLAID_CLIENT_ID && config.PLAID_SECRET, "请配置 Plaid 凭据");
  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[config.PLAID_ENV],
      baseOptions: {
        timeout: 30000,
        signal,
        headers: { "PLAID-CLIENT-ID": config.PLAID_CLIENT_ID, "PLAID-SECRET": config.PLAID_SECRET },
      },
    }),
  );
}
export class PlaidClient implements BankClient {
  private api: PlaidApi;
  constructor(config: PlaidConfig, signal?: AbortSignal) {
    this.api = plaidApi(config, signal);
  }
  async linkToken(request: LinkRequest) {
    const { products, ...rest } = request;
    const payload: LinkTokenCreateRequest = {
      ...rest,
      country_codes: [CountryCode.Us],
      ...(products
        ? {
            products: products.map((product) =>
              product === "transactions" ? Products.Transactions : Products.Investments,
            ),
          }
        : {}),
    };
    const { data } = await this.api.linkTokenCreate(payload);
    return { link_token: data.link_token, expiration: data.expiration };
  }
  async exchange(publicToken: string) {
    const { data } = await this.api.itemPublicTokenExchange({ public_token: publicToken });
    return { accessToken: data.access_token, itemId: data.item_id };
  }
  async accounts(accessToken: string) {
    const { data } = await this.api.accountsGet({ access_token: accessToken });
    if (data.item.error)
      throw {
        response: {
          data: {
            error_code: data.item.error.error_code,
            request_id: data.item.error.request_id ?? data.request_id,
          },
        },
      };
    return { accounts: data.accounts.map(account), item: item(data.item) };
  }
  async sync(accessToken: string, cursor: string | null) {
    const { data } = await this.api.transactionsSync({
      access_token: accessToken,
      ...(cursor ? { cursor } : {}),
      count: 500,
      options: { include_original_description: true },
    });
    return {
      accounts: data.accounts.map(account),
      added: data.added.map(transaction),
      modified: data.modified.map(transaction),
      removed: data.removed.map((row) => row.transaction_id),
      nextCursor: data.next_cursor,
      hasMore: data.has_more,
      updateStatus: data.transactions_update_status,
    };
  }
  async holdings(accessToken: string) {
    const { data } = await this.api.investmentsHoldingsGet({ access_token: accessToken });
    return {
      accounts: data.accounts.map(account),
      holdings: data.holdings.map((row) => ({
        accountId: row.account_id,
        value: decimal(row.institution_value)!,
        currency: currency(row.iso_currency_code, row.unofficial_currency_code),
        cash: data.securities.find((s) => s.security_id === row.security_id)?.is_cash_equivalent === true,
      })),
    };
  }
  async refresh(accessToken: string) {
    await this.api.transactionsRefresh({ access_token: accessToken });
  }
  async remove(accessToken: string) {
    await this.api.itemRemove({ access_token: accessToken });
  }
}
export async function testPlaidCredentials(config: PlaidConfig) {
  await plaidApi({ ...config, PLAID_ENABLED: "true" }).institutionsGet({
    count: 1,
    offset: 0,
    country_codes: [CountryCode.Us],
  });
}
export async function createSandboxPublicToken(config: PlaidConfig) {
  invariant(config.PLAID_ENV === "sandbox", "此脚本仅限 Sandbox");
  const { data } = await plaidApi(config).sandboxPublicTokenCreate({
    institution_id: "ins_109508",
    initial_products: [Products.Transactions],
    options: {
      override_username: "user_transactions_dynamic",
      override_password: "synthetic-only",
      transactions: { days_requested: config.PLAID_DAYS_REQUESTED },
    },
  });
  return data.public_token;
}
// Do not propagate SDK/Axios error objects: they contain request headers and tokens.
export function plaidError(error: unknown) {
  const data = (error as { response?: { data?: { error_code?: unknown; request_id?: unknown } } } | null)
    ?.response?.data;
  const safe = (value: unknown) =>
    typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null;
  return { errorCode: safe(data?.error_code) ?? "PLAID_REQUEST_FAILED", requestId: safe(data?.request_id) };
}
