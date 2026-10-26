import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { FakePlaid, bankAccount, bankTransaction, plaidConfig } from "./helpers/plaid";
import { bankConnections, bankConnectionAccounts, balanceSnapshots, users } from "@/db/schema";
import { historyStart, historyDaysRequested, availabilityStart } from "@/lib/bank-sync/date-range";
import {
  createLinkToken,
  exchangeConnection,
  saveMapping,
  listConnections,
} from "@/lib/bank-sync/connections";
import { syncConnection } from "@/lib/bank-sync/sync";
import { planBackfill } from "@/lib/bank-sync/backfill";
import { planReset } from "@/lib/bank-sync/reset";
import { createAccount, listAccounts, updateAccount } from "@/lib/ledger/accounts";
import { createQuickEntry } from "@/lib/ledger/builders";
import { voidEntry } from "@/lib/ledger/entries";
import { createSnapshot, publishSnapshot } from "@/lib/snapshots/service";
import { saveFxRate } from "@/lib/snapshots/fx";
import { accountGroups } from "@/db/schema";
import { buildBackcast, loadBackcast } from "@/lib/dashboard/backcast";
import type { BackcastAccount, BackcastInput } from "@/lib/dashboard/backcast-core";
import { monthSummary } from "@/lib/dashboard/month";
import { wealthOverview } from "@/lib/dashboard/wealth";
import { PersonalOverview } from "@/components/dashboard/personal-overview";
import { DashboardDetails } from "@/components/dashboard/details";
import { BackcastPanel } from "@/components/dashboard/backcast-panel";
import { backcastPlot } from "@/components/dashboard/backcast-chart";
import { ConnectionsView } from "@/components/bank-sync/connections-view";
import { ResetPreview } from "@/components/bank-sync/reset-form";
const config = {
  ...plaidConfig,
  PLAID_HISTORY_START: "2026-07-01",
  DATA_DIR: "/tmp/synthetic-backcast-test",
  FILE_RETENTION_DAYS: 30,
};
const now = new Date("2026-10-25T05:00:00Z"); // Owner-local October 24.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.client.close();
});
beforeEach(async () => {
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
  await h.db.update(users).set({ timezone: "America/Los_Angeles" }).where(eq(users.id, f.ownerId));
});
async function link(item = "one", cfg = config) {
  const client = new FakePlaid();
  client.item.id = item;
  client.accountRows = [bankAccount()];
  return {
    client,
    ...(await exchangeConnection(
      h.db,
      f.ownerId,
      client,
      cfg,
      {
        public_token: "synthetic",
        institution: { name: "Example Bank", institution_id: "ins_example" },
      },
      now,
    )),
  };
}
async function observe(date: string, values: Record<string, string>, complete = false) {
  const owned = await listAccounts(h.db, f.ownerId);
  const snapshot = await createSnapshot(h.db, f.ownerId, {
    snapshotDate: date,
    label: "Synthetic observation",
    items: owned
      .filter((row) => complete || row.id in values)
      .map((row) => ({
        accountId: row.id,
        balanceNative: values[row.id] ?? "0",
        currency: row.currency,
      })),
    fx: [{ quoteCurrency: "CNY", rate: "7", observedOn: date, source: "Synthetic" }],
  });
  return publishSnapshot(h.db, f.ownerId, snapshot.id);
}
it("history defaults use the configured start and local dates, capped730 with legacy fallback", () => {
  expect(historyStart(config, "2026-10-24")).toBe("2026-07-01");
  expect(historyDaysRequested(config, "2026-10-24")).toBe(122);
  expect(historyStart({ ...config, PLAID_HISTORY_START: "2020-01-01" }, "2026-10-24")).toBe("2024-10-24");
  expect(historyDaysRequested({ ...config, PLAID_HISTORY_START: "2020-01-01" }, "2026-10-24")).toBe(730);
  expect(historyStart(plaidConfig, "2026-10-24")).toBe("2026-07-26");
  expect(historyDaysRequested({ ...config, PLAID_HISTORY_START: "" }, "2026-10-24")).toBe(90);
  expect(availabilityStart("2026-10-24", 90)).toBe("2026-07-26");
});
it("real exchange ignores same-day snapshots, stores requested days, and Link requests the same local window", async () => {
  const snapshot = await observe("2026-10-24", { [f.bank.id]: "500" });
  await h.db
    .update(balanceSnapshots)
    .set({ source: "plaid", isComplete: false })
    .where(eq(balanceSnapshots.id, snapshot.id));
  const connection = await link();
  expect(connection.connection).toMatchObject({ importFromDate: "2026-07-01", daysRequested: 122 });
  await createLinkToken(h.db, f.ownerId, connection.client, config, "transactions", undefined, now);
  await createLinkToken(h.db, f.ownerId, connection.client, config, "investments", undefined, now);
  await createLinkToken(
    h.db,
    f.ownerId,
    connection.client,
    config,
    "transactions",
    connection.connection.id,
    now,
  );
  expect(connection.client.linkRequests[0].transactions).toEqual({ days_requested: 122 });
  expect(connection.client.linkRequests[1].transactions).toBeUndefined();
  expect(connection.client.linkRequests[2].products).toBeUndefined();
  expect(connection.client.linkRequests[2].transactions).toBeUndefined();
  const reused = await exchangeConnection(
    h.db,
    f.ownerId,
    connection.client,
    { ...config, PLAID_HISTORY_START: "2025-01-01" },
    { public_token: "again", institution: { name: "Example Bank", institution_id: null } },
    now,
  );
  expect(reused.connection.daysRequested).toBe(122);
});
it("backfill and reset use the shared default; an already-earlier backfill stays earlier", async () => {
  const linked = await link();
  await saveMapping(
    h.db,
    f.ownerId,
    linked.connection.id,
    config,
    { importFromDate: "2026-10-24", accounts: [{ id: linked.accounts[0].id, accountId: f.bank.id }] },
    now,
  );
  expect((await planBackfill(h.db, f.ownerId, linked.connection.id, config, {}, now)).targetFromDate).toBe(
    "2026-07-01",
  );
  expect((await planReset(h.db, f.ownerId, config, { connections: [linked.connection.id] }, now)).from).toBe(
    "2026-07-01",
  );
  await h.db
    .update(bankConnections)
    .set({ importFromDate: "2026-06-01" })
    .where(eq(bankConnections.id, linked.connection.id));
  expect((await planBackfill(h.db, f.ownerId, linked.connection.id, config, {}, now)).targetFromDate).toBe(
    "2026-06-01",
  );
});
it("existing90-day Items expose the approximate July26 availability in connection and reset UI", async () => {
  const linked = await link();
  await h.db
    .update(bankConnections)
    .set({ daysRequested: 90 })
    .where(eq(bankConnections.id, linked.connection.id));
  const connections = await listConnections(h.db, f.ownerId, config);
  expect(connections[0].availabilityStart).toBe("2026-07-26");
  const html = renderToStaticMarkup(
    <ConnectionsView
      connections={JSON.parse(JSON.stringify(connections))}
      accounts={[]}
      environment="sandbox"
      interval={12}
      timezone="America/Los_Angeles"
    />,
  );
  expect(html).toContain("Plaid 可提供的历史起点 ≈ 2026-07-26");
  expect(html).toContain("重新连接会消耗 Trial 名额");
  const plan = await planReset(h.db, f.ownerId, config, { connections: "all" }, now);
  expect(renderToStaticMarkup(<ResetPreview plan={plan} names={{}} />)).toContain("2026-07-26");
});

const account = (id: string, changes: Partial<BackcastAccount> = {}): BackcastAccount => ({
  id,
  name: `Synthetic ${id}`,
  currency: "USD",
  side: "asset",
  security: false,
  openedOn: null,
  plaidCoverageStart: "2026-10-01",
  observations: [{ date: "2026-10-05", balance: "100", frozenRate: "1", itemId: id }],
  flows: [],
  ...changes,
});
const input = (accounts: BackcastAccount[], changes: Partial<BackcastInput> = {}): BackcastInput => ({
  from: "2026-10-01",
  to: "2026-10-05",
  baseCurrency: "USD",
  accounts,
  rates: [],
  observations: [],
  ...changes,
});
it("rollback and roll-forward preserve transfer sums with cash, card and loan signs", () => {
  const flow = (date: string, amount: string) => ({
    date,
    amount,
    entryId: `${date}:${amount}`,
    opening: false,
  });
  const data = input([
    account("cash", {
      observations: [{ date: "2026-10-03", balance: "1100", frozenRate: "1", itemId: "cash" }],
      flows: [flow("2026-10-02", "-200"), flow("2026-10-03", "300"), flow("2026-10-05", "100")],
    }),
    account("card", {
      side: "liability",
      observations: [{ date: "2026-10-05", balance: "50", frozenRate: "1", itemId: "card" }],
      flows: [flow("2026-10-02", "200"), flow("2026-10-04", "-50")],
    }),
    account("loan", {
      side: "liability",
      observations: [{ date: "2026-10-01", balance: "-400", frozenRate: "1", itemId: "loan" }],
      flows: [flow("2026-10-03", "-300")],
    }),
  ]);
  const result = buildBackcast(data);
  expect(result.days.map((day) => day.netWorth)).toEqual([
    "500.0000000000",
    "500.0000000000",
    "500.0000000000",
    "450.0000000000",
    "550.0000000000",
  ]);
  expect(result.days.at(-1)).toMatchObject({
    assets: "1200.0000000000",
    liabilities: "650.0000000000",
    complete: true,
  });
  expect(buildBackcast({ ...data, accounts: [...data.accounts].reverse() })).toEqual(result);
});
it("coverage gaps, known zero before opening, and no-anchor opening fallback stay explicit", () => {
  const result = buildBackcast(
    input([
      account("early"),
      account("late", { plaidCoverageStart: "2026-10-03" }),
      account("opening-only", {
        observations: [],
        plaidCoverageStart: null,
        flows: [{ date: "2026-10-02", amount: "25", entryId: "opening", opening: true }],
      }),
      account("no-anchor", { observations: [], openedOn: "2026-10-04" }),
    ]),
  );
  expect(result.days[0].uncovered.map((row) => row.id)).toEqual(["no-anchor", "late", "opening-only"]);
  expect(result.days[2]).toMatchObject({ assets: "225.0000000000", complete: false, estimated: false });
  expect(result.days[3].uncovered).toEqual([
    { id: "no-anchor", name: "Synthetic no-anchor", reason: "缺少余额观察和已确认期初" },
  ]);
  expect(buildBackcast(input([])).days[0]).toMatchObject({ assets: null, netWorth: null, complete: false });
});
it("securities use only observed MV on or before each day, never invested cash flows", () => {
  const result = buildBackcast(
    input([
      account("stock", {
        security: true,
        observations: [
          { date: "2026-10-02", balance: "100", frozenRate: "1", itemId: "mv1" },
          { date: "2026-10-04", balance: "130", frozenRate: "1", itemId: "mv2" },
        ],
        flows: [{ date: "2026-10-01", amount: "9999", entryId: "buy", opening: true }],
      }),
    ]),
  );
  expect(result.days.map((day) => day.netWorth)).toEqual([
    "100.0000000000",
    "100.0000000000",
    "100.0000000000",
    "130.0000000000",
    "130.0000000000",
  ]);
  expect(result.days[0].complete).toBe(false);
});
it("FX uses each day's latest rate, flagged frozen fallback, and excludes missing FX", () => {
  const result = buildBackcast(
    input(
      [
        account("foreign", {
          currency: "CNY",
          observations: [{ date: "2026-10-05", balance: "100", frozenRate: "5", itemId: "fx" }],
        }),
      ],
      {
        rates: [
          { date: "2026-10-02", currency: "CNY", rate: "2", id: "a" },
          { date: "2026-10-04", currency: "CNY", rate: "4", id: "b" },
        ],
      },
    ),
  );
  expect(result.days.map((day) => day.netWorth)).toEqual([
    "20.0000000000",
    "50.0000000000",
    "50.0000000000",
    "25.0000000000",
    "25.0000000000",
  ]);
  expect(result.days[0].fxFallbackAccounts).toHaveLength(1);
  expect(result.days[1].fxFallbackAccounts).toEqual([]);
  const missing = buildBackcast(
    input([
      account("unknown", {
        currency: "EUR",
        observations: [{ date: "2026-10-05", balance: "100", frozenRate: null, itemId: "none" }],
      }),
    ]),
  );
  expect(missing.days[0]).toMatchObject({ netWorth: null, complete: false });
});
it("real services supply confirmed posted-date flows, independent markers, and leave monthly KPIs unchanged", async () => {
  const loan = await createAccount(h.db, f.ownerId, {
    name: "Synthetic Loan",
    type: "liability_loan",
    currency: "USD",
  });
  const start = await observe(
    "2026-10-01",
    { [f.bank.id]: "1000", [f.card.id]: "-100", [loan.id]: "-400" },
    true,
  );
  await createQuickEntry(h.db, f.ownerId, {
    type: "credit_card_payment",
    amount: "200",
    fromAccountId: f.bank.id,
    toAccountId: f.card.id,
    eventDate: "2026-10-01",
    postedDate: "2026-10-02",
  });
  await createQuickEntry(h.db, f.ownerId, {
    type: "transfer",
    amount: "300",
    fromAccountId: loan.id,
    toAccountId: f.bank.id,
    eventDate: "2026-10-03",
  });
  const expense = {
    type: "expense" as const,
    amount: "50",
    fromAccountId: f.card.id,
    categoryId: f.category("餐饮"),
    eventDate: "2026-10-04",
  };
  await createQuickEntry(h.db, f.ownerId, expense);
  await createQuickEntry(h.db, f.ownerId, { ...expense, amount: "999", status: "draft" });
  const voided = await createQuickEntry(h.db, f.ownerId, { ...expense, amount: "888" });
  await voidEntry(h.db, f.ownerId, voided.id, "Synthetic void");
  await createQuickEntry(h.db, f.ownerId, {
    type: "income",
    amount: "100",
    toAccountId: f.bank.id,
    categoryId: f.category("工资"),
    eventDate: "2026-10-05",
  });
  await observe("2026-10-05", { [f.bank.id]: "1200", [f.card.id]: "50", [loan.id]: "-700" });
  const before = await monthSummary(h.db, f.ownerId, "2026-10", "2026-10-05", "posted", "USD", 7);
  const result = await loadBackcast(h.db, f.ownerId, {
    from: "2026-10-01",
    to: "2026-10-05",
    baseCurrency: "USD",
  });
  expect(result.days.map((day) => day.netWorth)).toEqual([
    "500.0000000000",
    "500.0000000000",
    "500.0000000000",
    "450.0000000000",
    "550.0000000000",
  ]);
  expect(result.days[0].observations).toEqual([
    { date: "2026-10-01", snapshotId: start.id, netWorth: "500.0000000000" },
  ]);
  expect(result.days[4].observations).toEqual([]);
  expect(before).toMatchObject({ spending: { total: "50.0000000000" }, income: { total: "100.0000000000" } });
  expect(await monthSummary(h.db, f.ownerId, "2026-10", "2026-10-05", "posted", "USD", 7)).toEqual(before);
  expect(
    (await loadBackcast(h.db, f.otherId, { from: "2026-10-01", to: "2026-10-05", baseCurrency: "USD" }))
      .days[0].netWorth,
  ).toBeNull();
});
it("Plaid coverage takes max(import, override, availability), including legacy90-day Items", async () => {
  const linked = await link();
  await saveMapping(
    h.db,
    f.ownerId,
    linked.connection.id,
    config,
    { accounts: [{ id: linked.accounts[0].id, accountId: f.bank.id }], importFromDate: "2026-07-01" },
    now,
  );
  await h.db
    .update(bankConnections)
    .set({ daysRequested: 90 })
    .where(eq(bankConnections.id, linked.connection.id));
  await observe("2026-10-24", { [f.bank.id]: "100" });
  const series = () =>
    loadBackcast(h.db, f.ownerId, { from: "2026-07-25", to: "2026-07-28", baseCurrency: "USD" });
  // Observation must be no later than the calculation end; use a full range and inspect July days.
  const full = async () =>
    (await loadBackcast(h.db, f.ownerId, { from: "2026-07-25", to: "2026-10-24", baseCurrency: "USD" })).days;
  let days = await full();
  expect(days[0].uncovered.some((row) => row.id === f.bank.id)).toBe(true);
  expect(days[1].uncovered.some((row) => row.id === f.bank.id)).toBe(false);
  await h.db
    .update(bankConnectionAccounts)
    .set({ importFromDate: "2026-08-01" })
    .where(eq(bankConnectionAccounts.id, linked.accounts[0].id));
  days = await full();
  expect(days.find((day) => day.date === "2026-07-31")!.uncovered.some((row) => row.id === f.bank.id)).toBe(
    true,
  );
  expect(days.find((day) => day.date === "2026-08-01")!.uncovered.some((row) => row.id === f.bank.id)).toBe(
    false,
  );
  expect((await series()).days[0].uncovered.some((row) => row.id === f.bank.id)).toBe(true);
});
it("non-Plaid earliest opening extends coverage, inactive history stays, and aggregates aren't distributed", async () => {
  await createQuickEntry(h.db, f.ownerId, {
    type: "opening_balance",
    amount: "100",
    toAccountId: f.bank.id,
    eventDate: "2026-07-01",
  });
  await updateAccount(h.db, f.ownerId, f.bank.id, { isActive: false });
  const [group] = await h.db
    .insert(accountGroups)
    .values({
      ownerId: f.ownerId,
      name: "Synthetic aggregate",
      currency: "USD",
      cashLikeInclusion: true,
      financialInclusion: true,
    })
    .returning();
  await updateAccount(h.db, f.ownerId, f.broker.id, { accountGroupId: group.id });
  const snapshot = await createSnapshot(h.db, f.ownerId, {
    snapshotDate: "2026-10-01",
    label: "Synthetic group",
    items: [{ accountGroupId: group.id, currency: "USD", balanceNative: "200" }],
  });
  await publishSnapshot(h.db, f.ownerId, snapshot.id);
  const days = (
    await loadBackcast(h.db, f.ownerId, { from: "2026-07-01", to: "2026-10-24", baseCurrency: "USD" })
  ).days;
  expect(days[0].assets).toBe("100.0000000000");
  expect(days.at(-1)!.uncovered.some((row) => row.id === f.broker.id)).toBe(true);
});
it("daily FX loader and complete-snapshot markers retain independent frozen rates", async () => {
  await observe("2026-10-01", { [f.wallet.id]: "700" }, true);
  await saveFxRate(h.db, f.ownerId, {
    baseCurrency: "USD",
    quoteCurrency: "CNY",
    rate: "10",
    observedOn: "2026-10-02",
    source: "Synthetic",
  });
  const series = await loadBackcast(h.db, f.ownerId, {
    from: "2026-10-01",
    to: "2026-10-02",
    baseCurrency: "USD",
  });
  expect(series.days[0].netWorth).toBe("100.0000000000");
  expect(series.days[0].observations[0].netWorth).toBe("100.0000000000");
  expect(series.days[1].netWorth).toBe("70.0000000000");
});
it("home and net-worth details share the chart, partial segments and honest empty states", async () => {
  const computed = buildBackcast(
    input([account("bank"), account("late", { plaidCoverageStart: "2026-10-03" })]),
  );
  const series = { ...computed, historyStart: "2026-07-01" };
  const data = {
    backcast: series,
    wealth: await wealthOverview(h.db, f.ownerId, "2026-10-05", "USD", 14, 7),
    month: await monthSummary(h.db, f.ownerId, "2026-10", "2026-10-05", "posted", "USD", 7),
  };
  for (const html of [
    renderToStaticMarkup(<PersonalOverview {...data} />),
    renderToStaticMarkup(<DashboardDetails {...data} view="net-worth" />),
  ]) {
    expect(html).toContain("净资产走势（按交易回溯）");
    expect(html).not.toContain("以下账户在覆盖起点前按最早已知余额估计");
    expect(html).not.toContain("全程未计入");
    expect(html).toContain("自 7月1日");
    expect(html).toContain("近 90 天");
    expect(html).toContain("近 30 天");
  }
  const plotted = backcastPlot(computed.days);
  expect(plotted[0].netSolid).toBeNull();
  expect(plotted[0].netPartial).toBe(200);
  expect(plotted[2].netPartial).toBe(200); // Boundary is connected to the complete segment.
  expect(plotted[3].netPartial).toBeNull();
  expect(plotted[3].netSolid).toBe(200);
  const empty = { ...buildBackcast(input([])), historyStart: "2026-07-01" };
  const emptyHtml = renderToStaticMarkup(<BackcastPanel series={empty} />);
  expect(emptyHtml).toContain("还没有可回溯的余额");
  expect(emptyHtml).toMatch(/href="\/accounts"[^>]*>去账户页更新余额/);
  expect(emptyHtml).not.toContain("录入账户余额或期初");
});
it("balance-only loans and investment cash carry observations forward without fictional earlier flows", async () => {
  const loan = await createAccount(h.db, f.ownerId, {
    name: "Example Loan",
    type: "liability_loan",
    currency: "USD",
  });
  const client = new FakePlaid();
  client.item.id = "balance-only";
  client.item.products = ["investments"];
  client.accountRows = [bankAccount("loan", "loan", "500"), bankAccount("invest", "investment", "100")];
  const linked = await exchangeConnection(
    h.db,
    f.ownerId,
    client,
    config,
    { public_token: "synthetic", institution: { name: "Example Broker", institution_id: null } },
    now,
  );
  await saveMapping(
    h.db,
    f.ownerId,
    linked.connection.id,
    config,
    {
      importFromDate: linked.connection.importFromDate,
      accounts: linked.accounts.map((row) => ({
        id: row.id,
        accountId: row.type === "loan" ? loan.id : f.broker.id,
        ...(row.type === "investment" ? { securityAccountId: f.security.id } : {}),
      })),
    },
    now,
  );
  await createQuickEntry(h.db, f.ownerId, {
    type: "opening_balance",
    amount: "-400",
    toAccountId: loan.id,
    eventDate: "2026-10-02",
  });
  await observe("2026-10-03", { [loan.id]: "-500", [f.broker.id]: "100" });
  // A manual flow must not be rolled through balance-only observed history.
  await createQuickEntry(h.db, f.ownerId, {
    type: "transfer",
    amount: "50",
    fromAccountId: loan.id,
    toAccountId: f.bank.id,
    eventDate: "2026-10-04",
  });
  const series = await loadBackcast(h.db, f.ownerId, {
    from: "2026-10-01",
    to: "2026-10-05",
    baseCurrency: "USD",
  });
  expect(series.days.map((day) => day.liabilities)).toEqual([
    "400.0000000000",
    "400.0000000000",
    "500.0000000000",
    "500.0000000000",
    "500.0000000000",
  ]);
  expect(series.days[0].uncovered.some((row) => row.id === loan.id)).toBe(true);
  expect(series.observationOnlyAccounts.map((row) => row.id).sort()).toEqual([loan.id, f.broker.id].sort());
  expect(
    renderToStaticMarkup(<BackcastPanel series={{ ...series, historyStart: "2026-07-01" }} />),
  ).toContain("按余额观察（无流水）");
  const connections = await listConnections(h.db, f.ownerId, config);
  expect(
    renderToStaticMarkup(
      <ConnectionsView
        connections={JSON.parse(JSON.stringify(connections))}
        accounts={[]}
        environment="sandbox"
        interval={12}
        timezone="America/Los_Angeles"
      />,
    ),
  ).toContain("此连接不提供交易流水，仅同步余额/持仓");
});
it("pending bank transactions and draft observations never affect the derived series", async () => {
  const linked = await link();
  await saveMapping(
    h.db,
    f.ownerId,
    linked.connection.id,
    config,
    {
      importFromDate: linked.connection.importFromDate,
      accounts: [{ id: linked.accounts[0].id, accountId: f.bank.id }],
    },
    now,
  );
  linked.client.page = () => ({
    accounts: linked.client.accountRows,
    added: [
      bankTransaction("pending", { amount: "99", pending: true }),
      bankTransaction("posted", { amount: "20", date: "2026-10-23", authorizedDate: "2026-10-21" }),
    ],
    modified: [],
    removed: [],
    hasMore: false,
    nextCursor: "synthetic-final",
    updateStatus: "HISTORICAL_UPDATE_COMPLETE",
  });
  await syncConnection(h.db, f.ownerId, linked.connection.id, linked.client, config, now);
  await createSnapshot(h.db, f.ownerId, {
    snapshotDate: "2026-10-24",
    label: "Draft must be ignored",
    items: [{ accountId: f.bank.id, balanceNative: "9999", currency: "USD" }],
  });
  const series = await loadBackcast(h.db, f.ownerId, {
    from: "2026-10-22",
    to: "2026-10-24",
    baseCurrency: "USD",
  });
  expect(series.days.map((day) => day.assets)).toEqual([
    "1020.0000000000",
    "1000.0000000000",
    "1000.0000000000",
  ]);
});
it("same-day FX revisions use the latest record, not random UUID order", async () => {
  await observe("2026-10-01", { [f.wallet.id]: "700" }, true);
  await saveFxRate(h.db, f.ownerId, {
    baseCurrency: "USD",
    quoteCurrency: "CNY",
    rate: "5",
    observedOn: "2026-10-01",
    source: "Older",
  });
  await saveFxRate(h.db, f.ownerId, {
    baseCurrency: "USD",
    quoteCurrency: "CNY",
    rate: "10",
    observedOn: "2026-10-01",
    source: "Newer",
  });
  const day = (
    await loadBackcast(h.db, f.ownerId, { from: "2026-10-01", to: "2026-10-01", baseCurrency: "USD" })
  ).days[0];
  expect(day.netWorth).toBe("70.0000000000");
  expect(day.observations[0].netWorth).toBe("100.0000000000");
});
it("a future configured start is rejected before creating or exchanging an Item", async () => {
  const client = new FakePlaid();
  const exchange = vi.spyOn(client, "exchange");
  const future = { ...config, PLAID_HISTORY_START: "2027-01-01" };
  await expect(
    createLinkToken(h.db, f.ownerId, client, future, "transactions", undefined, now),
  ).rejects.toThrow("历史起点不能晚于本地今天");
  await expect(
    exchangeConnection(
      h.db,
      f.ownerId,
      client,
      future,
      { public_token: "synthetic", institution: { name: "Example", institution_id: null } },
      now,
    ),
  ).rejects.toThrow("历史起点不能晚于本地今天");
  expect(client.linkRequests).toEqual([]);
  expect(exchange).not.toHaveBeenCalled();
});
it("holds first-covered balance before coverage without a partial-sum dip or account-set jump", () => {
  const data = input([
    account("cash", {
      plaidCoverageStart: "2026-10-03",
      flows: [{ date: "2026-10-04", amount: "-20", entryId: "spend", opening: false }],
    }),
    account("card", {
      side: "liability",
      observations: [{ date: "2026-10-05", balance: "-50", frozenRate: "1", itemId: "card" }],
    }),
  ]);
  const series = buildBackcast(data);
  expect(series.accountIds).toEqual(["card", "cash"]);
  expect(series.days.map((day) => day.netWorth)).toEqual([
    "70.0000000000",
    "70.0000000000",
    "70.0000000000",
    "50.0000000000",
    "50.0000000000",
  ]);
  expect(series.days.map((day) => day.estimated)).toEqual([true, true, false, false, false]);
  expect(series.days.map((day) => day.complete)).toEqual([false, false, true, true, true]);
  expect(series.days[0].estimatedAccounts).toEqual([
    { id: "cash", name: "Synthetic cash", coverageStart: "2026-10-03" },
  ]);
  expect(series.excluded).toEqual([]);
});
it("no-anchor or no-FX accounts stay excluded throughout; early FX uses a flagged earliest known rate", () => {
  const series = buildBackcast(
    input(
      [
        account("foreign", {
          currency: "CNY",
          observations: [{ date: "2026-10-05", balance: "100", frozenRate: null, itemId: "foreign" }],
        }),
        account("missing", { observations: [], flows: [] }),
        account("no-rate", {
          currency: "EUR",
          observations: [{ date: "2026-10-05", balance: "200", frozenRate: null, itemId: "no-rate" }],
        }),
      ],
      { rates: [{ currency: "CNY", date: "2026-10-03", rate: "10", id: "known-rate" }] },
    ),
  );
  expect(series.accountIds).toEqual(["foreign"]);
  expect(series.excluded.map((row) => row.id)).toEqual(["missing", "no-rate"]);
  expect(series.days.every((day) => day.netWorth === "10.0000000000")).toBe(true);
  expect(series.days.map((day) => day.estimated)).toEqual([true, true, false, false, false]);
  expect(series.days.every((day) => !day.complete)).toBe(true);
  expect(series.days[0].fxFallbackAccounts).toEqual([{ id: "foreign", name: "Synthetic foreign" }]);
});
it("before opened_on remains a known zero, and securities before first MV are explicit estimates", () => {
  const series = buildBackcast(input([account("new-account", { openedOn: "2026-10-03" })]));
  expect(series.days[0]).toMatchObject({ assets: "0.0000000000", complete: true, estimated: false });
  expect(series.days[2].assets).toBe("100.0000000000");
  const mv = buildBackcast(
    input([
      account("security", {
        security: true,
        observations: [{ date: "2026-10-03", balance: "120", itemId: "mv", frozenRate: "1" }],
      }),
    ]),
  );
  expect(mv.days.every((day) => day.netWorth === "120.0000000000")).toBe(true);
  expect(mv.days.map((day) => day.estimated)).toEqual([true, true, false, false, false]);
});
it("caption reports when all mapped Transactions banks have history, plus the earliest bank", async () => {
  const first = await link("first");
  const second = await link("second");
  const bank = await createAccount(h.db, f.ownerId, {
    name: "Example Other Bank",
    type: "asset_cash",
    currency: "USD",
  });
  for (const [connection, accountId, daysRequested] of [
    [first, f.bank.id, 90],
    [second, bank.id, 60],
  ] as const) {
    await saveMapping(
      h.db,
      f.ownerId,
      connection.connection.id,
      config,
      { importFromDate: "2026-07-01", accounts: [{ id: connection.accounts[0].id, accountId }] },
      now,
    );
    await h.db
      .update(bankConnections)
      .set({ daysRequested })
      .where(eq(bankConnections.id, connection.connection.id));
  }
  await observe("2026-10-24", { [f.bank.id]: "100", [bank.id]: "200" });
  const series = await loadBackcast(h.db, f.ownerId, {
    from: "2026-07-01",
    to: "2026-10-24",
    baseCurrency: "USD",
  });
  expect(series.plaidAvailability).toEqual({ earliest: "2026-07-26", latest: "2026-08-25" });
  expect(series.days.every((day) => day.assets === "300.0000000000")).toBe(true);
  const html = renderToStaticMarkup(<BackcastPanel series={{ ...series, historyStart: "2026-07-01" }} />);
  expect(html).not.toContain("Plaid 自");
  expect(html).not.toContain("各银行最早");
  expect(html).not.toContain("text-amber-800");
});

it("empty history start uses the owner-local 90-day window in Link, backfill, reset, connection hints and chart labels", async () => {
  const emptyConfig = { ...config, PLAID_HISTORY_START: "" };
  const start = historyStart(emptyConfig, "2026-10-24");
  expect(start).toBe("2026-07-26");
  const linked = await link("empty-history", emptyConfig);
  expect(linked.connection).toMatchObject({ importFromDate: start, daysRequested: 90 });
  await createLinkToken(h.db, f.ownerId, linked.client, emptyConfig, "transactions", undefined, now);
  expect(linked.client.linkRequests[0].transactions).toEqual({ days_requested: 90 });
  await saveMapping(
    h.db,
    f.ownerId,
    linked.connection.id,
    emptyConfig,
    {
      importFromDate: "2026-10-24",
      accounts: [{ id: linked.accounts[0].id, accountId: f.bank.id }],
    },
    now,
  );
  expect(
    (await planBackfill(h.db, f.ownerId, linked.connection.id, emptyConfig, {}, now)).targetFromDate,
  ).toBe(start);
  const reset = await planReset(h.db, f.ownerId, emptyConfig, { connections: "all" }, now);
  expect(reset.from).toBe(start);
  expect(renderToStaticMarkup(<ResetPreview plan={reset} names={{}} />)).toContain(start);
  const connections = await listConnections(h.db, f.ownerId, emptyConfig);
  expect(connections[0].importFromDate).toBe("2026-10-24");
  expect(connections[0].daysRequested).toBe(90);
  const html = renderToStaticMarkup(
    <ConnectionsView
      connections={JSON.parse(JSON.stringify(connections))}
      accounts={[]}
      environment="sandbox"
      interval={12}
      timezone="America/Los_Angeles"
    />,
  );
  expect(html).toContain(`Plaid 可提供的历史起点 ≈ ${start}`);
  const series = buildBackcast(input([], { from: start, to: "2026-10-24" }));
  const chart = renderToStaticMarkup(<BackcastPanel series={{ ...series, historyStart: start }} />);
  expect(chart).toContain("自 7月26日");
  expect(chart).not.toContain("NaN");
  expect(chart).toContain("近 90 天");
  await h.db
    .update(bankConnections)
    .set({ importFromDate: "2026-06-01" })
    .where(eq(bankConnections.id, linked.connection.id));
  expect(
    (await planBackfill(h.db, f.ownerId, linked.connection.id, emptyConfig, {}, now)).targetFromDate,
  ).toBe("2026-06-01");
});
