import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { FakePlaid, bankAccount, bankTransaction, plaidConfig as config } from "./helpers/plaid";
import { balanceSnapshots, snapshotFx, statements, importRows } from "@/db/schema";
import { createAccount, listAccounts, updateAccount } from "@/lib/ledger/accounts";
import { createQuickEntry, buildPostings } from "@/lib/ledger/builders";
import { createEntry, voidEntry } from "@/lib/ledger/entries";
import { balancesAsOf } from "@/lib/ledger/queries";
import { createSnapshot, publishSnapshot } from "@/lib/snapshots/service";
import { saveFxRate } from "@/lib/snapshots/fx";
import { accountGroups } from "@/db/schema";
import { accountPositions } from "@/lib/ledger/observed-balances";
import { confirmObservedOpening } from "@/lib/ledger/opening-observation";
import { exchangeConnection, saveMapping, listConnections } from "@/lib/bank-sync/connections";
import { syncConnection } from "@/lib/bank-sync/sync";
import { clearingInput } from "@/lib/bank-sync/transfer-legs";
import { benefitInput } from "@/lib/benefits/input";
import { wealthOverview } from "@/lib/dashboard/wealth";
import { monthSummary, monthWindow } from "@/lib/dashboard/month";
import { loadBackcast } from "@/lib/dashboard/backcast";
import { PersonalOverview } from "@/components/dashboard/personal-overview";
import { DashboardDetails } from "@/components/dashboard/details";
import { AccountsView } from "@/components/ledger/accounts-view";
let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
const today = "2026-10-24";
const now = new Date("2026-10-24T12:00:00Z");
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.client.close();
});
beforeEach(async () => {
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
});
async function observe(
  date: string,
  items: { accountId?: string; accountGroupId?: string; balanceNative: string; currency: string }[],
  source: "manual" | "plaid" = "manual",
  fx: { quoteCurrency: string; rate: string; observedOn: string; source: string }[] = [],
) {
  const snapshot = await createSnapshot(h.db, f.ownerId, {
    snapshotDate: date,
    label: "Synthetic balance",
    items,
    fx,
  });
  await publishSnapshot(h.db, f.ownerId, snapshot.id);
  await h.db.update(balanceSnapshots).set({ source }).where(eq(balanceSnapshots.id, snapshot.id));
  return snapshot;
}
const positions = () => accountPositions(h.db, f.ownerId, today);
const wealth = () => wealthOverview(h.db, f.ownerId, today, "USD", 14, 7);
const backcast = async () => ({
  ...(await loadBackcast(h.db, f.ownerId, { from: "2026-07-01", to: today, baseCurrency: "USD" })),
  historyStart: "2026-07-01",
});
const month = (value = "2026-10") => monthSummary(h.db, f.ownerId, value, today, "posted", "USD", 7);
async function spend(
  accountId: string,
  amount: string,
  date: string,
  source: "manual" | "import" = "manual",
) {
  return createEntry(h.db, f.ownerId, {
    ...(await buildPostings(h.db, f.ownerId, "expense", {
      amount,
      fromAccountId: accountId,
      categoryId: f.category("餐饮"),
      eventDate: date,
    })),
    source,
  });
}
it("offers manually-created later-mapped accounts the same all-source opening as the connection card", async () => {
  await spend(f.bank.id, "10", "2026-08-15");
  const pdf = await spend(f.bank.id, "20", "2026-09-03", "import");
  const [statement] = await h.db
    .insert(statements)
    .values({
      ownerId: f.ownerId,
      accountId: f.bank.id,
      mime: "application/pdf",
      originalFilename: "synthetic.pdf",
      sizeBytes: 100,
      fileSha256: "b".repeat(64),
    })
    .returning();
  await h.db.insert(importRows).values({
    ownerId: f.ownerId,
    statementId: statement.id,
    rowIndex: 0,
    sourceRowText: "synthetic",
    confidence: "1",
    direction: "charge",
    descriptionRaw: "Example PDF",
    merchantNormalized: "Example PDF",
    amountRaw: "20",
    amount: "-20",
    currency: "USD",
    rowSignature: "synthetic",
    journalEntryId: pdf.id,
    decision: "approve",
    source: "parser",
  });
  const client = new FakePlaid();
  client.accountRows = [bankAccount("checking", "depository", "500")];
  const linked = await exchangeConnection(
    h.db,
    f.ownerId,
    client,
    config,
    { public_token: "synthetic", institution: { name: "Example Bank", institution_id: "ins_synthetic" } },
    now,
  );
  await saveMapping(
    h.db,
    f.ownerId,
    linked.connection.id,
    config,
    { importFromDate: "2026-09-01", accounts: [{ id: linked.accounts[0].id, accountId: f.bank.id }] },
    now,
  );
  client.page = () => ({
    accounts: client.accountRows,
    added: [bankTransaction("plaid-spend", { accountId: "checking", amount: "30" })],
    modified: [],
    removed: [],
    hasMore: false,
    nextCursor: "synthetic-1",
    updateStatus: "HISTORICAL_UPDATE_COMPLETE",
  });
  await syncConnection(h.db, f.ownerId, linked.connection.id, client, config, now);
  const account = (await positions()).find((row) => row.account.id === f.bank.id)!;
  expect(account.suggestion).toMatchObject({
    syncedBalance: "500.0000",
    syncedFlows: "-60.0000",
    amount: "560.0000",
    eventDate: "2026-08-14",
    transactionCount: 3,
  });
  expect((await listConnections(h.db, f.ownerId))[0].accounts[0].openingSuggestion).toMatchObject(
    account.suggestion!,
  );
  const first = await confirmObservedOpening(h.db, f.ownerId, f.bank.id, { amount: "560" });
  const repeat = await confirmObservedOpening(h.db, f.ownerId, f.bank.id, { amount: "800" });
  expect(repeat.id).toBe(first.id);
  expect((await positions()).find((row) => row.account.id === f.bank.id)).toMatchObject({
    ledger: "500.0000",
    difference: "0.0000",
    suggestion: null,
  });
});
it("can skip account-page opening suggestions without changing balance data or default callers", async () => {
  await spend(f.bank.id, "30", "2026-10-20");
  await observe(today, [{ accountId: f.bank.id, balanceNative: "200", currency: "USD" }]);
  const before = await positions();
  expect(before.find((row) => row.account.id === f.bank.id)?.suggestion).not.toBeNull();
  const withoutSuggestions = await accountPositions(h.db, f.ownerId, today, { includeSuggestions: false });
  expect(withoutSuggestions).toEqual(before.map((row) => ({ ...row, suggestion: null })));
  expect(await positions()).toEqual(before);
});
it("card openings preserve negative signs; existing draft/confirmed blocks, voided does not; tiles show observations", async () => {
  await spend(f.card.id, "30", "2026-10-20");
  await observe(today, [{ accountId: f.card.id, balanceNative: "-200", currency: "USD" }]);
  expect((await positions()).find((row) => row.account.id === f.card.id)?.suggestion).toMatchObject({
    amount: "-170.0000",
    eventDate: "2026-10-19",
  });
  const opening = await confirmObservedOpening(h.db, f.ownerId, f.card.id, { amount: "-160" });
  let position = (await positions()).find((row) => row.account.id === f.card.id)!;
  expect(position).toMatchObject({ ledger: "-190.0000", difference: "10.0000", suggestion: null });
  const html = renderToStaticMarkup(
    <AccountsView
      accounts={await balancesAsOf(h.db, f.ownerId, today)}
      institutions={[]}
      groups={[]}
      today={today}
      positions={[{ ...position, accountId: position.account.id }]}
    />,
  );
  expect(html).toContain("手工 10-24");
  expect(html).toMatch(/data-money-value="" class="[^"]*whitespace-nowrap/);
  expect(html).not.toContain("账本比银行多");
  expect(html).not.toContain("进入对账");
  expect(html).not.toContain("期初");
  await voidEntry(h.db, f.ownerId, opening.id, "Synthetic correction");
  position = (await positions()).find((row) => row.account.id === f.card.id)!;
  expect(position.suggestion).not.toBeNull();
  await createQuickEntry(h.db, f.ownerId, {
    type: "opening_balance",
    amount: "-170",
    toAccountId: f.card.id,
    eventDate: "2026-10-19",
    status: "draft",
  });
  expect((await positions()).find((row) => row.account.id === f.card.id)?.suggestion).toBeNull();
});
it("blocks observation-based openings until older undecided import rows are reviewed", async () => {
  await observe(today, [{ accountId: f.bank.id, balanceNative: "100", currency: "USD" }]);
  const [statement] = await h.db
    .insert(statements)
    .values({
      ownerId: f.ownerId,
      accountId: f.bank.id,
      mime: "text/csv",
      originalFilename: "synthetic.csv",
      sizeBytes: 100,
      fileSha256: "c".repeat(64),
    })
    .returning();
  const [row] = await h.db
    .insert(importRows)
    .values({
      ownerId: f.ownerId,
      statementId: statement.id,
      rowIndex: 0,
      sourceRowText: "synthetic",
      confidence: "1",
      direction: "charge",
      descriptionRaw: "Synthetic pending review",
      merchantNormalized: "Synthetic",
      amountRaw: "5",
      amount: "-5",
      currency: "USD",
      rowSignature: "synthetic",
      postedDate: "2026-10-23",
      source: "csv",
    })
    .returning();
  expect((await positions()).find((row) => row.account.id === f.bank.id)).toMatchObject({
    pendingCount: 1,
    suggestion: null,
  });
  await expect(confirmObservedOpening(h.db, f.ownerId, f.bank.id, { amount: "100" })).rejects.toThrow(
    "还有 1 笔待审核流水",
  );
  await h.db.update(importRows).set({ decision: "exclude" }).where(eq(importRows.id, row.id));
  expect((await positions()).find((row) => row.account.id === f.bank.id)?.suggestion?.amount).toBe(
    "100.0000",
  );
  await expect(confirmObservedOpening(h.db, f.otherId, f.bank.id, { amount: "100" })).rejects.toThrow(
    "不存在",
  );
});
it("latest mixed observations, frozen FX, opening-only fallback and securities MV produce honest totals", async () => {
  const loan = await createAccount(h.db, f.ownerId, {
    name: "Synthetic Loan",
    type: "liability_loan",
    currency: "USD",
  });
  await observe(
    "2026-10-01",
    [
      { accountId: f.bank.id, balanceNative: "900", currency: "USD" },
      { accountId: f.card.id, balanceNative: "-100", currency: "USD" },
      { accountId: f.wallet.id, balanceNative: "670", currency: "CNY" },
      { accountId: loan.id, balanceNative: "-300", currency: "USD" },
    ],
    "manual",
    [{ quoteCurrency: "CNY", rate: "6.7", observedOn: "2026-10-01", source: "Synthetic" }],
  );
  await observe(today, [{ accountId: f.bank.id, balanceNative: "1200", currency: "USD" }], "plaid");
  await createQuickEntry(h.db, f.ownerId, {
    type: "opening_balance",
    amount: "50",
    toAccountId: f.broker.id,
    eventDate: "2026-10-01",
  });
  await createQuickEntry(h.db, f.ownerId, {
    type: "opening_balance",
    amount: "999",
    toAccountId: f.security.id,
    eventDate: "2026-10-01",
  });
  await saveFxRate(h.db, f.ownerId, {
    baseCurrency: "USD",
    quoteCurrency: "CNY",
    rate: "8",
    observedOn: today,
    source: "New catalog",
  });
  let result = await wealth();
  expect(result).toMatchObject({
    assets: "1350.0000000000",
    liabilities: "400.0000000000",
    netWorth: "950.0000000000",
  });
  expect(result.rows.find((row) => row.id === f.wallet.id)).toMatchObject({
    value: "100.0000000000",
    stale: true,
    staleFx: true,
  });
  expect(result.excluded.find((row) => row.id === f.security.id)?.reason).toBe("未录入市值");
  expect(result.rows.find((row) => row.id === f.broker.id)?.source).toContain("账本推算");
  await observe(today, [{ accountId: f.security.id, balanceNative: "500", currency: "USD" }]);
  result = await wealth();
  expect(result.netWorth).toBe("1450.0000000000");
  expect(
    (await accountPositions(h.db, f.ownerId, today)).find((row) => row.account.id === f.security.id)
      ?.suggestion,
  ).toBeNull();
  expect((await wealthOverview(h.db, f.otherId, today, "USD", 14, 7)).rows).toEqual([]);
});
it("excludes missing FX rather than assuming parity; group aggregates cannot mix debt and assets", async () => {
  const snap = await observe(
    today,
    [
      { accountId: f.wallet.id, balanceNative: "670", currency: "CNY" },
      { accountId: f.bank.id, balanceNative: "100", currency: "USD" },
    ],
    "manual",
    [{ quoteCurrency: "CNY", rate: "6.7", observedOn: today, source: "Synthetic" }],
  );
  await h.db.delete(snapshotFx).where(eq(snapshotFx.snapshotId, snap.id));
  expect(await wealth()).toMatchObject({ assets: "100.0000000000", missingFx: [f.wallet.name] });
  const [group] = await h.db
    .insert(accountGroups)
    .values({
      ownerId: f.ownerId,
      name: "Mixed legacy",
      currency: "USD",
      cashLikeInclusion: true,
      financialInclusion: true,
    })
    .returning();
  await updateAccount(h.db, f.ownerId, f.bank.id, { accountGroupId: group.id });
  await updateAccount(h.db, f.ownerId, f.card.id, { accountGroupId: group.id });
  await observe(today, [{ accountGroupId: group.id, balanceNative: "50", currency: "USD" }]);
  expect((await wealth()).excluded.some((row) => row.reason.includes("无法区分"))).toBe(true);
});
it("negative assets and overpaid cards retain signs; only complete snapshots enter history", async () => {
  const snapshot = await observe(
    "2026-10-20",
    (await listAccounts(h.db, f.ownerId)).map((account) => ({
      accountId: account.id,
      currency: account.currency,
      balanceNative: account.id === f.bank.id ? "100" : "0",
    })),
    "manual",
    [{ quoteCurrency: "CNY", rate: "7", observedOn: "2026-10-20", source: "Synthetic" }],
  );
  expect(
    (await h.db.select().from(balanceSnapshots).where(eq(balanceSnapshots.id, snapshot.id)))[0].isComplete,
  ).toBe(true);
  await observe(
    today,
    [
      { accountId: f.bank.id, balanceNative: "-10", currency: "USD" },
      { accountId: f.card.id, balanceNative: "20", currency: "USD" },
    ],
    "plaid",
  );
  const result = await wealth();
  expect(result).toMatchObject({
    assets: "-10.0000000000",
    liabilities: "-20.0000000000",
    netWorth: "10.0000000000",
  });
  expect(result.history.map((row) => row.date)).toEqual(["2026-10-20", "2026-10-24 · 最新余额"]);
});
it("month switching keeps transfers/clearing out and counts benefit refunds as negative spending", async () => {
  await spend(f.card.id, "100", "2026-10-01");
  await spend(f.bank.id, "40", "2026-09-15");
  await createEntry(
    h.db,
    f.ownerId,
    await benefitInput(h.db, f.ownerId, {
      accountId: f.card.id,
      amount: "15",
      currency: "USD",
      eventDate: "2026-10-22",
      family: "dining",
    }),
  );
  await createQuickEntry(h.db, f.ownerId, {
    type: "income",
    amount: "200",
    toAccountId: f.bank.id,
    categoryId: f.category("工资"),
    eventDate: "2026-10-01",
  });
  await createQuickEntry(h.db, f.ownerId, {
    type: "transfer",
    amount: "80",
    fromAccountId: f.bank.id,
    toAccountId: f.broker.id,
    eventDate: "2026-10-12",
  });
  await createEntry(
    h.db,
    f.ownerId,
    await clearingInput(h.db, f.ownerId, {
      accountId: f.card.id,
      amount: "50",
      currency: "USD",
      transactionDate: "2026-10-20",
      postedDate: null,
      descriptionRaw: "PAYMENT THANK YOU",
      merchantNormalized: "payment thank you",
    }),
  );
  const result = await month();
  expect(result.spending.total).toBe("85.0000000000");
  expect(result.income.total).toBe("200.0000000000");
  expect(result.spending.categories[0]).toMatchObject({ category: "餐饮", share: "100.0" });
  expect((await month("2026-09")).spending.total).toBe("40.0000000000");
  expect(monthWindow("2026-01", today)).toMatchObject({ previous: "2025-12", next: "2026-02" });
  expect(monthWindow("invalid", today).month).toBe("2026-10");
  const data = { wealth: await wealth(), month: result, backcast: await backcast() };
  const html = renderToStaticMarkup(<PersonalOverview {...data} />);
  for (const removed of ["待处理", "连接银行", "最近交易", "最近对账", "积分估值", "银行同步未启用"])
    expect(html).not.toContain(removed);
  for (const key of ["assets", "liabilities", "net-worth", "spending", "income"])
    expect(html).toContain(`view=${key}`);
  expect(html).not.toContain('aria-label="统计月份"');
  expect(html).toContain("本月支出");
  expect(html).toContain("本月收入");
  expect(html).toContain("month=2026-10");
  expect(renderToStaticMarkup(<DashboardDetails {...data} view="spending" />)).toContain(
    'aria-label="统计月份"',
  );
  expect(html).toContain("grid-cols-1");
  expect(html).toContain("sm:grid-cols-2");
  expect(html).toContain("lg:grid-cols-3");
  expect(html).toContain("row-start-1 bg-primary");
  expect(html).toMatch(/data-money-value="" class="[^"]*whitespace-nowrap/);
  expect(renderToStaticMarkup(<DashboardDetails {...data} view="spending" />)).toMatch(
    /data-money-value="" class="[^"]*whitespace-nowrap/,
  );
  expect(renderToStaticMarkup(<DashboardDetails {...data} view="income" />)).toContain("工资");
});
it("empty states have no fabricated balances and all five details remain usable", async () => {
  const data = { wealth: await wealth(), month: await month(), backcast: await backcast() };
  expect(data.wealth.assets).toBeNull();
  const html = renderToStaticMarkup(<PersonalOverview {...data} />);
  expect(html).toContain("个账户未录入余额");
  expect(html).toMatch(/href="\/accounts"[^>]*>去账户页更新余额 →/);
  expect(renderToStaticMarkup(<DashboardDetails {...data} view="assets" />)).toContain("尚无可展示余额");
});
