import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { FakePlaid, bankAccount, plaidConfig as config } from "./helpers/plaid";
import { auditLogs, bankConnections, accounts, importJobs, journalEntries, snapshotItems } from "@/db/schema";
import { createSession } from "@/lib/auth/session";
import {
  connectionAccounts,
  createLinkToken,
  dismissNewAccounts,
  exchangeConnection,
  listConnections,
  refreshConnection,
  requireConnection,
  saveMapping,
} from "@/lib/bank-sync/connections";
import { syncConnection } from "@/lib/bank-sync/sync";
import { accountReminders, type ReminderConnection } from "@/lib/bank-sync/account-reminders";
import { accountReminderSummaries } from "@/lib/bank-sync/account-reminder-summaries";
import { plaidWebhookUrl, usesHttpsWebhook } from "@/lib/bank-sync/webhook-url";
import { ConnectionsView } from "@/components/bank-sync/connections-view";
import { connectionNeedsAttention } from "@/components/bank-sync/connection-disclosure";
import { jsonSafe } from "@/lib/serialization";

let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
let client: FakePlaid;
const now = new Date("2026-10-24T12:00:00Z");
const later = new Date("2026-10-25T12:00:00Z");
const https = { ...config, APP_URL: "https://ledger.example.test/" };
vi.mock("@/db/client", () => ({ getDb: () => h.db }));
vi.mock("@/lib/auth/current-user", () => ({
  requireUser: async () => ({ id: f.ownerId, timezone: "UTC", baseCurrency: "USD" }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/statements",
}));
vi.mock("@/lib/bank-sync/plaid-client", async (original) => ({
  ...(await original<typeof import("@/lib/bank-sync/plaid-client")>()),
  PlaidClient: class {
    constructor() {
      return client;
    }
  },
}));
const linkRoute = await import("@/app/api/plaid/connections/[id]/link-token/route");
const reauthRoute = await import("@/app/api/plaid/connections/[id]/reauth/route");
const dismissRoute = await import("@/app/api/plaid/connections/[id]/dismiss-new-accounts/route");
const { default: Dashboard } = await import("@/app/(app)/dashboard/page");
const { default: Layout } = await import("@/app/(app)/layout");
const { default: BankSettings } = await import("@/app/(app)/settings/banks/page");
const { default: Statements } = await import("@/app/(app)/statements/page");
beforeAll(async () => {
  h = await createTestDb();
  for (const [key, value] of Object.entries(config)) vi.stubEnv(key, String(value));
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic/test");
});
afterAll(async () => {
  await h.client.close();
  vi.unstubAllEnvs();
});
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
  client = new FakePlaid();
  vi.stubEnv("APP_URL", config.APP_URL);
  vi.stubEnv("PLAID_ENABLED", "true");
});
async function connect() {
  const result = await exchangeConnection(
    h.db,
    f.ownerId,
    client,
    config,
    {
      public_token: "public-synthetic",
      institution: { institution_id: "synthetic", name: "Example Bank" },
    },
    now,
  );
  await saveMapping(
    h.db,
    f.ownerId,
    result.connection.id,
    config,
    {
      importFromDate: result.connection.importFromDate,
      accounts: result.accounts.map((row) => ({
        id: row.id,
        accountId: row.type === "credit" ? f.card.id : f.bank.id,
        isEnabled: true,
      })),
    },
    now,
  );
  return result.connection.id;
}
const flag = (id: string) =>
  h.db.update(bankConnections).set({ newAccountsAvailableAt: now }).where(eq(bankConnections.id, id));
async function request(
  id: string,
  body?: unknown,
  owner: string | null = f.ownerId,
  origin = config.APP_URL,
) {
  const session = owner ? await createSession(h.db, owner, { ipHash: "synthetic", userAgent: "test" }) : null;
  return new NextRequest(`${config.APP_URL}/api/plaid/connections/${id}`, {
    method: "POST",
    headers: {
      host: "localhost:3000",
      origin,
      "content-type": "application/json",
      ...(session ? { cookie: `al_session=${session.token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });

it("registers only HTTPS URLs on new Link tokens and sends product-free account selection in update mode", async () => {
  expect(plaidWebhookUrl(config.APP_URL)).toBe("http://localhost:3000/api/plaid/webhook");
  expect(plaidWebhookUrl(https.APP_URL)).toBe("https://ledger.example.test/api/plaid/webhook");
  expect(usesHttpsWebhook(config.APP_URL)).toBe(false);
  expect(usesHttpsWebhook(https.APP_URL)).toBe(true);
  await createLinkToken(h.db, f.ownerId, client, config, "transactions", undefined, now);
  await createLinkToken(h.db, f.ownerId, client, https, "investments", undefined, now);
  expect(client.linkRequests[0]).not.toHaveProperty("webhook");
  expect(client.linkRequests[1].webhook).toBe(plaidWebhookUrl(https.APP_URL));
  const id = await connect();
  await createLinkToken(h.db, f.ownerId, client, https, "transactions", id, now, { accountSelection: true });
  expect(client.linkRequests[2]).toMatchObject({
    update: { account_selection_enabled: true },
    access_token: client.accessToken,
  });
  expect(client.linkRequests[2]).not.toHaveProperty("products");
  expect(client.linkRequests[2]).not.toHaveProperty("transactions");
  expect(client.linkRequests[2]).not.toHaveProperty("webhook");
  expect((await linkRoute.POST(await request(id, { accountSelection: true }), context(id))).status).toBe(200);
  expect(client.linkRequests.at(-1)?.update).toEqual({ account_selection_enabled: true });
  expect((await linkRoute.POST(await request(id), context(id))).status).toBe(200);
  expect(client.linkRequests.at(-1)).not.toHaveProperty("update");
  expect((await linkRoute.POST(await request(id, { accountSelection: "true" }), context(id))).status).toBe(
    400,
  );
});

it("stores HTTPS registration during exchange and updates changed URLs during sync, including HTTP", async () => {
  const result = await exchangeConnection(
    h.db,
    f.ownerId,
    client,
    https,
    {
      public_token: "public-synthetic",
      institution: { institution_id: "synthetic", name: "Example Bank" },
    },
    now,
  );
  expect(result.connection.webhookUrl).toBe(plaidWebhookUrl(https.APP_URL));
  await saveMapping(
    h.db,
    f.ownerId,
    result.connection.id,
    config,
    { importFromDate: result.connection.importFromDate, accounts: [] },
    now,
  );
  await syncConnection(h.db, f.ownerId, result.connection.id, client, config, later);
  expect(client.webhooks).toEqual([plaidWebhookUrl(config.APP_URL)]);
  await syncConnection(h.db, f.ownerId, result.connection.id, client, https, later);
  await syncConnection(h.db, f.ownerId, result.connection.id, client, https, later);
  expect(client.webhooks).toEqual([plaidWebhookUrl(config.APP_URL), plaidWebhookUrl(https.APP_URL)]);
});

it("leaves HTTP exchange registration empty until sync registers the Item webhook", async () => {
  const id = await connect();
  expect((await requireConnection(h.db, f.ownerId, id)).webhookUrl).toBeNull();
  expect(client.webhooks).toEqual([]);
  await syncConnection(h.db, f.ownerId, id, client, config, later);
  expect(client.webhooks).toEqual([plaidWebhookUrl(config.APP_URL)]);
  expect((await requireConnection(h.db, f.ownerId, id)).webhookUrl).toBe(plaidWebhookUrl(config.APP_URL));
});

it("continues sync after webhook registration failure and retries on the next sync", async () => {
  const id = await connect();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const update = vi
    .spyOn(client, "updateWebhook")
    .mockRejectedValueOnce(new Error("sensitive-provider-details"));
  const first = await syncConnection(h.db, f.ownerId, id, client, config, later);
  expect(first.notReady).toBe(false);
  expect((await requireConnection(h.db, f.ownerId, id)).webhookUrl).toBeNull();
  expect(log).toHaveBeenCalledWith(JSON.stringify({ kind: "plaid_webhook_update_failed", connectionId: id }));
  await syncConnection(h.db, f.ownerId, id, client, config, later);
  expect(update).toHaveBeenCalledTimes(2);
  expect((await requireConnection(h.db, f.ownerId, id)).webhookUrl).toBe(plaidWebhookUrl(config.APP_URL));
});

it("marks only missing full-refresh accounts, preserves mappings, restores returned accounts and clears only selection reminders", async () => {
  const id = await connect();
  await flag(id);
  const ledgerBefore = await h.db.select().from(accounts);
  client.accountRows = [bankAccount(), bankAccount("new-card", "credit")];
  await refreshConnection(h.db, f.ownerId, id, client, config, later);
  let rows = await connectionAccounts(h.db, f.ownerId, id);
  expect(rows.find((row) => row.plaidAccountId === "card")).toMatchObject({
    unsharedAt: later,
    isEnabled: true,
    accountId: f.card.id,
  });
  expect(rows.find((row) => row.plaidAccountId === "new-card")).toMatchObject({
    unsharedAt: null,
    isEnabled: false,
    accountId: null,
    createdAt: later,
  });
  expect((await requireConnection(h.db, f.ownerId, id)).newAccountsAvailableAt).toEqual(now);
  expect((await requireConnection(h.db, f.ownerId, id)).newAccountsHandledAt).toBeNull();
  expect(await h.db.select().from(accounts)).toHaveLength(ledgerBefore.length);
  expect(await h.db.select().from(journalEntries)).toHaveLength(0);
  client.page = () => ({
    accounts: [bankAccount("card", "credit")],
    added: [],
    modified: [],
    removed: [],
    nextCursor: "restored",
    hasMore: false,
    updateStatus: "HISTORICAL_UPDATE_COMPLETE",
  });
  await syncConnection(h.db, f.ownerId, id, client, config, later);
  rows = await connectionAccounts(h.db, f.ownerId, id);
  expect(rows.every((row) => row.unsharedAt === null)).toBe(true);
  client.accountRows = [];
  await refreshConnection(h.db, f.ownerId, id, client, config, later, { accountSelection: true });
  expect((await connectionAccounts(h.db, f.ownerId, id)).every((row) => row.unsharedAt !== null)).toBe(true);
  expect((await requireConnection(h.db, f.ownerId, id)).newAccountsAvailableAt).toBeNull();
  expect((await requireConnection(h.db, f.ownerId, id)).newAccountsHandledAt).toEqual(later);
  const completedAgain = new Date(later.getTime() + 60000);
  await refreshConnection(h.db, f.ownerId, id, client, config, completedAgain, { accountSelection: true });
  expect((await requireConnection(h.db, f.ownerId, id)).newAccountsHandledAt).toEqual(completedAgain);
  client.accountRows = [bankAccount()];
  await refreshConnection(h.db, f.ownerId, id, client, config, later);
  expect(
    (await connectionAccounts(h.db, f.ownerId, id)).find((row) => row.plaidAccountId === "bank")!.unsharedAt,
  ).toBeNull();
});

it("reauth accepts the optional selection flag, clears the reminder and keeps queueing sync", async () => {
  const id = await connect();
  await flag(id);
  expect((await reauthRoute.POST(await request(id), context(id))).status).toBe(200);
  expect((await requireConnection(h.db, f.ownerId, id)).newAccountsAvailableAt).toEqual(now);
  expect((await reauthRoute.POST(await request(id, { accountSelection: true }), context(id))).status).toBe(
    200,
  );
  expect((await requireConnection(h.db, f.ownerId, id)).newAccountsAvailableAt).toBeNull();
  expect(await h.db.select().from(importJobs)).toHaveLength(1);
});

it("preserves investment values when holdings omit an account and observes zero only for a returned empty portfolio", async () => {
  const broker = bankAccount("broker", "investment");
  client.accountRows = [broker];
  client.item.products = ["investments"];
  const result = await exchangeConnection(
    h.db,
    f.ownerId,
    client,
    config,
    {
      public_token: "synthetic",
      institution: { institution_id: "synthetic-broker", name: "Example Brokerage" },
    },
    now,
  );
  const id = result.connection.id;
  await saveMapping(
    h.db,
    f.ownerId,
    id,
    config,
    {
      importFromDate: result.connection.importFromDate,
      accounts: [
        {
          id: result.accounts[0].id,
          accountId: f.broker.id,
          securityAccountId: f.security.id,
          isEnabled: true,
        },
      ],
    },
    now,
  );
  client.holdingsResult = {
    accounts: [broker],
    holdings: [
      { accountId: broker.id, value: "100.0000", currency: "USD", cash: true },
      { accountId: broker.id, value: "900.0000", currency: "USD", cash: false },
    ],
  };
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  const observations = () => h.db.select().from(snapshotItems).where(eq(snapshotItems.ownerId, f.ownerId));
  const before = await observations();
  expect(before.map((row) => row.balanceNative).sort()).toEqual(["100.0000", "900.0000"]);
  client.accountRows = [];
  client.holdingsResult = { accounts: [], holdings: [] };
  await refreshConnection(h.db, f.ownerId, id, client, config, later, { accountSelection: true });
  await syncConnection(h.db, f.ownerId, id, client, config, later);
  expect(await observations()).toEqual(before);
  expect((await connectionAccounts(h.db, f.ownerId, id))[0].unsharedAt).toEqual(later);
  client.accountRows = [broker];
  client.holdingsResult = { accounts: [broker], holdings: [] };
  await syncConnection(h.db, f.ownerId, id, client, config, later);
  const after = await observations();
  expect(after).toHaveLength(4);
  expect(after.filter((row) => row.balanceNative === "0.0000")).toHaveLength(2);
  expect((await connectionAccounts(h.db, f.ownerId, id))[0].unsharedAt).toBeNull();
});

it("dismisses only the authenticated owner's reminder, requires origin/session, and audits once", async () => {
  const id = await connect();
  await flag(id);
  await expect(dismissNewAccounts(h.db, f.otherId, id)).rejects.toThrow("银行连接不存在");
  expect((await dismissRoute.POST(await request(id, undefined, f.otherId), context(id))).status).toBe(404);
  expect((await dismissRoute.POST(await request(id, undefined, null), context(id))).status).toBe(401);
  expect(
    (await dismissRoute.POST(await request(id, undefined, f.ownerId, "https://other.test"), context(id)))
      .status,
  ).toBe(403);
  expect((await requireConnection(h.db, f.ownerId, id)).newAccountsAvailableAt).toEqual(now);
  expect((await dismissRoute.POST(await request(id), context(id))).status).toBe(200);
  const handledAt = (await requireConnection(h.db, f.ownerId, id)).newAccountsHandledAt;
  expect(handledAt).toBeInstanceOf(Date);
  await dismissNewAccounts(h.db, f.ownerId, id);
  expect((await requireConnection(h.db, f.ownerId, id)).newAccountsHandledAt).toEqual(handledAt);
  const logs = await h.db.select().from(auditLogs).where(eq(auditLogs.action, "bank.new_accounts_dismissed"));
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({ ownerId: f.ownerId, entityId: id, changes: {} });
});

it("counts all reminder cases once per connection and excludes revoked, other-owner and other-environment connections", async () => {
  const id = await connect();
  await flag(id);
  client.accountRows = [bankAccount(), bankAccount("new-card", "credit")];
  await refreshConnection(h.db, f.ownerId, id, client, config, later);
  expect(await accountReminderSummaries(h.db, f.ownerId, "sandbox")).toEqual([
    {
      id,
      institutionName: "Example Bank",
      newAccountsAvailable: true,
      unmappedNewAccounts: 1,
      unsharedMapped: 1,
    },
  ]);
  expect(await accountReminderSummaries(h.db, f.otherId, "sandbox")).toEqual([]);
  expect(await accountReminderSummaries(h.db, f.ownerId, "production")).toEqual([]);
  expect(renderToStaticMarkup(await Layout({ children: null }))).toContain('aria-label="1 项待处理"');
  const [connection] = jsonSafe(await listConnections(h.db, f.ownerId, config));
  expect(accountReminders(connection)).toEqual({
    newAccountsAvailable: true,
    unmappedNewAccounts: 1,
    unsharedMapped: 1,
    needsAttention: true,
  });
  expect(connectionNeedsAttention(connection)).toBe(true);
  const html = renderToStaticMarkup(
    <ConnectionsView
      connections={[connection]}
      accounts={[]}
      environment="sandbox"
      interval={12}
      timezone="UTC"
    />,
  );
  for (const text of [
    "Example Bank 有新账户可以添加",
    "添加账户",
    "暂不添加",
    "发现 1 个新账户，确认映射后开始同步",
    "1 个账户已停止共享，不再同步。如不再需要，可在账户映射中停用。",
    "添加或移除账户",
    "已停止共享",
  ])
    expect(html).toContain(text);
  expect(html).toContain('aria-expanded="true"');
  await h.db
    .update(bankConnections)
    .set({ status: "revoked" })
    .where(and(eq(bankConnections.id, id), eq(bankConnections.ownerId, f.ownerId)));
  expect(await accountReminderSummaries(h.db, f.ownerId, "sandbox")).toEqual([]);
});

it("shows the dashboard card above KPIs and nav count from summaries only while Plaid is enabled", async () => {
  const id = await connect();
  await flag(id);
  let dashboard = await Dashboard({ searchParams: Promise.resolve({}) });
  expect(dashboard.props.bankAccountReminders).toEqual([
    {
      id,
      institutionName: "Example Bank",
      newAccountsAvailable: true,
      unmappedNewAccounts: 0,
      unsharedMapped: 0,
    },
  ]);
  const html = renderToStaticMarkup(dashboard);
  expect(html).toContain("银行账户有变化");
  expect(html.indexOf("</header>")).toBeLessThan(html.indexOf('aria-labelledby="bank-account-changes"'));
  expect(html.indexOf('aria-labelledby="bank-account-changes"')).toBeLessThan(
    html.indexOf('aria-label="资产与收支"'),
  );
  expect(renderToStaticMarkup(await Layout({ children: null }))).toContain('aria-label="1 项待处理"');
  vi.stubEnv("PLAID_ENABLED", "false");
  dashboard = await Dashboard({ searchParams: Promise.resolve({}) });
  expect(dashboard.props.bankAccountReminders).toEqual([]);
  expect(renderToStaticMarkup(dashboard)).not.toContain("银行账户有变化");
  expect(renderToStaticMarkup(await Layout({ children: null }))).not.toContain("项待处理");
});

it("shows polling for HTTP installs and polling plus real-time reception for HTTPS", async () => {
  expect(renderToStaticMarkup(await BankSettings())).toContain(
    "新账户通知：每次同步时查询 Plaid 通知记录（本机地址无法实时接收）",
  );
  expect(
    renderToStaticMarkup(await Statements({ searchParams: Promise.resolve({ tab: "sync" }) })),
  ).toContain("新账户会在每次同步时检查（最长约 12 小时）；也可随时点「添加或移除账户」。");
  vi.stubEnv("APP_URL", https.APP_URL);
  expect(renderToStaticMarkup(await BankSettings())).toContain(plaidWebhookUrl(https.APP_URL));
  expect(renderToStaticMarkup(await BankSettings())).toContain(
    "新账户通知：实时接收，并在每次同步时核对 Plaid 通知记录",
  );
  expect(
    renderToStaticMarkup(await Statements({ searchParams: Promise.resolve({ tab: "sync" }) })),
  ).not.toContain("新账户会在每次同步时检查");
});

it("does not count previously declined accounts, exact confirmation timestamps, or unshared disabled accounts as new", () => {
  const account = {
    isEnabled: false,
    accountId: null,
    securityAccountId: null,
    unsharedAt: null,
    createdAt: now,
  };
  const connection: ReminderConnection = {
    status: "active",
    newAccountsAvailableAt: null,
    mappingConfirmedAt: now,
    accounts: [
      account,
      { ...account, createdAt: new Date(now.getTime() - 1) },
      { ...account, createdAt: later, unsharedAt: later },
    ],
  };
  expect(accountReminders(connection).needsAttention).toBe(false);
  connection.accounts.push({ ...account, createdAt: later });
  expect(accountReminders(connection).unmappedNewAccounts).toBe(1);
  expect(accountReminders({ ...connection, mappingConfirmedAt: null }).unmappedNewAccounts).toBe(0);
  expect(
    accountReminders({ ...connection, status: "revoked", newAccountsAvailableAt: later }).needsAttention,
  ).toBe(false);
});
