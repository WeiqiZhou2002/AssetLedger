import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  users,
  auditLogs,
  balanceSnapshots,
  bankConnectionAccounts,
  bankConnections,
  journalEntries,
  statements,
} from "@/db/schema";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { createAccount, updateAccount } from "@/lib/ledger/accounts";
import { updateAccountBalance } from "@/lib/ledger/balance-updates";
import { accountBalanceTracking, balanceReminderDue } from "@/lib/ledger/balance-tracking";
import { createSnapshot, getSnapshot, updateSnapshot } from "@/lib/snapshots/service";
import { saveFxRate, deleteFxRate } from "@/lib/snapshots/fx";
import { createSession } from "@/lib/auth/session";
import { observeStatementBalance, retainFiles } from "@/lib/imports/evidence";
import { readEnv } from "@/lib/env";
import { AccountsView } from "@/components/ledger/accounts-view";
import { AccountForm } from "@/components/ledger/account-form";
import { BalanceControls, BalanceUpdateForm } from "@/components/ledger/balance-update-form";
import { NewAccountFields, readNewAccount } from "@/components/imports/new-account-fields";
import { AppNavigation } from "@/components/app-navigation";
import { balancesAsOf } from "@/lib/ledger/queries";
import { wealthOverview } from "@/lib/dashboard/wealth";
import { monthSummary } from "@/lib/dashboard/month";
import { loadBackcast } from "@/lib/dashboard/backcast";
import { PersonalOverview } from "@/components/dashboard/personal-overview";

let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
let token: string;
let foreign: string;
let directory: string;
const today = "2026-10-25";
const now = new Date("2026-10-26T02:00:00Z");
vi.mock("@/db/client", () => ({ getDb: () => h.db }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/accounts",
}));
const balanceRoute = await import("@/app/api/accounts/[id]/balance/route");
const accountRoute = await import("@/app/api/accounts/[id]/route");
beforeAll(async () => {
  h = await createTestDb();
  directory = await mkdtemp(join(tmpdir(), "synthetic-balances-"));
  vi.stubEnv("APP_SECRET", "synthetic-balance-test-secret-32-chars");
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic/test");
  vi.stubEnv("DATA_DIR", directory);
});
afterAll(async () => {
  await h.client.close();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
  await h.db.update(users).set({ timezone: "America/Los_Angeles" }).where(eq(users.id, f.ownerId));
  token = (await createSession(h.db, f.ownerId, { ipHash: "synthetic", userAgent: "Test" })).token;
  foreign = (await createSession(h.db, f.otherId, { ipHash: "synthetic", userAgent: "Test" })).token;
});
const update = (accountId: string, amount: unknown, date = today, extra = {}) =>
  updateAccountBalance(h.db, f.ownerId, accountId, { amount, date, ...extra }, now);
const context = (id: string) => ({ params: Promise.resolve({ id }) });
function request(
  body: unknown,
  session: string | null = token,
  origin = "http://localhost:3000",
  method = "POST",
) {
  return new NextRequest("http://localhost:3000/api/accounts/balance", {
    method,
    headers: {
      host: "localhost:3000",
      origin,
      "Content-Type": "application/json",
      ...(session ? { cookie: `al_session=${session}` } : {}),
    },
    body: JSON.stringify(body),
  });
}
async function mapping(
  accountId: string,
  securityAccountId: string | null = null,
  isEnabled = true,
  ownerId = f.ownerId,
) {
  const [connection] = await h.db
    .insert(bankConnections)
    .values({
      ownerId,
      environment: "sandbox",
      plaidItemId: crypto.randomUUID(),
      accessTokenEnc: "synthetic",
      institutionName: "Example Bank",
      importFromDate: "2026-10-01",
      lastSuccessAt: now,
    })
    .returning();
  const [row] = await h.db
    .insert(bankConnectionAccounts)
    .values({
      ownerId,
      connectionId: connection.id,
      plaidAccountId: crypto.randomUUID(),
      name: "Demo Account",
      type: "investment",
      accountId,
      securityAccountId,
      isEnabled,
      currency: "USD",
    })
    .returning();
  return row;
}
it("publishes exact signed balances and security market values without postings, with ids-only audit", async () => {
  const card = await update(f.card.id, "-200.1234");
  const observation = await getSnapshot(h.db, f.ownerId, card.id);
  expect(observation).toMatchObject({
    source: "manual",
    status: "published",
    snapshotDate: today,
    label: "余额更新",
  });
  expect(observation.items).toHaveLength(1);
  expect(observation.items[0]).toMatchObject({
    accountId: f.card.id,
    currency: "USD",
    balanceNative: "-200.1234",
  });
  const overpayment = await update(f.card.id, "25.50");
  expect((await getSnapshot(h.db, f.ownerId, overpayment.id)).items[0].balanceNative).toBe("25.5000");
  const security = await update(f.security.id, "12345.6789");
  expect((await getSnapshot(h.db, f.ownerId, security.id)).label).toBe("市值更新");
  expect(
    (await wealthOverview(h.db, f.ownerId, today, "USD", 7, 7)).rows.find((row) => row.id === f.security.id),
  ).toBeDefined();
  expect(await h.db.select().from(journalEntries)).toHaveLength(0);
  const audit = await h.db.select().from(auditLogs).where(eq(auditLogs.action, "account.balance_update"));
  expect(audit).toHaveLength(3);
  expect(JSON.stringify(audit)).not.toMatch(/200\.1234|12345\.6789|25\.50/);
  expect(Object.keys(audit[0].changes ?? {})).toEqual(["snapshotId"]);
});
it("guards owner, active real accounts and enabled cash/security mappings; disabled mappings allow manual updates", async () => {
  await expect(
    updateAccountBalance(h.db, f.otherId, f.bank.id, { amount: "1", date: today }, now),
  ).rejects.toThrow("不存在");
  await expect(update(f.expense.id, "1")).rejects.toThrow("真实账户");
  await updateAccount(h.db, f.ownerId, f.bank.id, { isActive: false });
  await expect(update(f.bank.id, "1")).rejects.toThrow("启用");
  const linked = await mapping(f.broker.id, f.security.id);
  for (const id of [f.broker.id, f.security.id]) {
    await expect(update(id, "1")).rejects.toThrow("Plaid");
    await expect(updateAccount(h.db, f.ownerId, id, { balanceReminderDays: 1 })).rejects.toThrow("Plaid");
  }
  await h.db
    .update(bankConnectionAccounts)
    .set({ isEnabled: false })
    .where(eq(bankConnectionAccounts.id, linked.id));
  await expect(update(f.security.id, "1")).resolves.toHaveProperty("id");
  expect(await accountBalanceTracking(h.db, f.otherId, today)).toEqual([]);
});
it("validates decimal strings, real dates and owner-local future boundary, including zero", async () => {
  for (const amount of [1.25, "NaN", "1e3", "1.23456"])
    await expect(update(f.bank.id, amount)).rejects.toThrow();
  await expect(update(f.bank.id, "0", "2026-02-30")).rejects.toThrow();
  await expect(update(f.bank.id, "0", "2026-10-26")).rejects.toThrow("今天");
  await expect(update(f.bank.id, "0")).resolves.toHaveProperty("id");
  expect(await h.db.select().from(balanceSnapshots)).toHaveLength(1);
});
it("uses dated FX, supports inline FX, freezes rates and rolls back missing FX atomically", async () => {
  await expect(update(f.wallet.id, "670")).rejects.toThrow("缺少 USD/CNY 汇率");
  expect(await h.db.select().from(balanceSnapshots)).toHaveLength(0);
  const rate = await saveFxRate(h.db, f.ownerId, {
    baseCurrency: "USD",
    quoteCurrency: "CNY",
    rate: "6.7",
    observedOn: "2026-10-20",
    source: "Synthetic",
  });
  await saveFxRate(h.db, f.ownerId, {
    baseCurrency: "USD",
    quoteCurrency: "CNY",
    rate: "7",
    observedOn: "2026-11-01",
    source: "Future synthetic",
  });
  const saved = await update(f.wallet.id, "670");
  await deleteFxRate(h.db, f.ownerId, rate.id);
  expect((await getSnapshot(h.db, f.ownerId, saved.id)).fx[0].rate).toBe("6.7000000000");
  const inline = await update(f.wallet.id, "680", today, {
    fx: { rate: "6.8", observedOn: today, source: "Synthetic manual" },
  });
  expect((await getSnapshot(h.db, f.ownerId, inline.id)).fx[0].rate).toBe("6.8000000000");
  await expect(
    update(f.wallet.id, "1", today, { fx: { rate: "6.8", observedOn: "2026-10-26", source: "Synthetic" } }),
  ).rejects.toThrow("汇率日期");
  const published = await getSnapshot(h.db, f.ownerId, inline.id);
  await updateSnapshot(h.db, f.ownerId, inline.id, {
    expectedRevision: published.revision,
    items: [{ accountId: f.wallet.id, currency: "CNY", balanceNative: "681" }],
  });
  expect((await getSnapshot(h.db, f.ownerId, inline.id)).history).toHaveLength(2);
  await expect(
    updateSnapshot(h.db, f.ownerId, inline.id, { expectedRevision: published.revision + 1, fx: [] }),
  ).rejects.toThrow("冻结");
});
it("calculates strict reminder boundaries and ignores drafts, other accounts and Plaid mapping accounts", async () => {
  expect(balanceReminderDue(true, 7, "2026-10-18", today)).toBe(false);
  expect(balanceReminderDue(true, 7, "2026-10-17", today)).toBe(true);
  expect(balanceReminderDue(true, null, null, today)).toBe(false);
  expect(balanceReminderDue(false, 1, null, today)).toBe(false);
  await update(f.bank.id, "100", "2026-10-17");
  await update(f.card.id, "-10", "2026-10-18");
  await createSnapshot(h.db, f.ownerId, {
    snapshotDate: today,
    label: "Draft",
    items: [{ accountId: f.bank.id, currency: "USD", balanceNative: "200" }],
  });
  await mapping(f.broker.id, f.security.id);
  const tracking = await accountBalanceTracking(h.db, f.ownerId, today);
  expect(tracking.find((row) => row.accountId === f.bank.id)).toMatchObject({
    manual: true,
    reminderDue: true,
    latestObservationDate: "2026-10-17",
  });
  expect(tracking.find((row) => row.accountId === f.card.id)?.reminderDue).toBe(false);
  for (const id of [f.broker.id, f.security.id])
    expect(tracking.find((row) => row.accountId === id)).toMatchObject({
      manual: false,
      reminderDue: false,
      plaidSynced: true,
      lastSyncedAt: now.toISOString(),
    });
  for (const days of [null, 1, 3, 7, 14, 30])
    expect(
      (await updateAccount(h.db, f.ownerId, f.bank.id, { balanceReminderDays: days })).balanceReminderDays,
    ).toBe(days);
  expect(
    (await accountBalanceTracking(h.db, f.ownerId, today)).find((row) => row.accountId === f.bank.id)
      ?.reminderDue,
  ).toBe(false);
  for (const days of [0, -1, 2, 1.5, "7"])
    await expect(updateAccount(h.db, f.ownerId, f.bank.id, { balanceReminderDays: days })).rejects.toThrow();
  const created = await createAccount(h.db, f.ownerId, {
    name: "New manual",
    type: "asset_cash",
    currency: "USD",
  });
  expect(created.balanceReminderDays).toBe(7);
});
it("authenticates balance/frequency API, checks origin, rejects client ownership and future dates", async () => {
  const values = { amount: "-12.50", date: "2026-10-01" };
  expect((await balanceRoute.POST(request(values, null), context(f.card.id))).status).toBe(401);
  expect(
    (await balanceRoute.POST(request(values, token, "https://evil.example"), context(f.card.id))).status,
  ).toBe(403);
  expect((await balanceRoute.POST(request(values, foreign), context(f.card.id))).status).toBe(404);
  for (const invalid of [
    { ...values, ownerId: f.otherId },
    { ...values, amount: 12.5 },
    { ...values, date: "2099-10-25" },
  ])
    expect((await balanceRoute.POST(request(invalid), context(f.card.id))).status).toBe(400);
  expect((await balanceRoute.POST(request(values), context(f.card.id))).status).toBe(200);
  expect(
    (
      await accountRoute.PATCH(
        request({ balanceReminderDays: null }, token, undefined, "PATCH"),
        context(f.card.id),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await accountRoute.PATCH(
        request({ balanceReminderDays: 1 }, foreign, undefined, "PATCH"),
        context(f.card.id),
      )
    ).status,
  ).toBe(404);
  await mapping(f.bank.id);
  expect((await balanceRoute.POST(request(values), context(f.bank.id))).status).toBe(400);
});
it("publishes statement observations once for manual accounts and blocks Plaid, future dates and missing FX", async () => {
  const make = async (accountId: string, date = "2026-10-01") =>
    (
      await h.db
        .insert(statements)
        .values({
          ownerId: f.ownerId,
          accountId,
          originalFilename: "synthetic.csv",
          fileSha256: crypto.randomUUID().replaceAll("-", "").repeat(2),
          sizeBytes: 1,
          mime: "text/csv",
          status: "needs_review",
          periodEnd: date,
          summary: { ending_balance: "-200" },
        })
        .returning()
    )[0];
  const statement = await make(f.card.id);
  const first = await observeStatementBalance(h.db, f.ownerId, statement.id);
  expect(first).toMatchObject({ status: "published", source: "statement", snapshotDate: "2026-10-01" });
  expect((await observeStatementBalance(h.db, f.ownerId, statement.id)).id).toBe(first.id);
  expect((await getSnapshot(h.db, f.ownerId, first.id)).history).toHaveLength(1);
  await expect(observeStatementBalance(h.db, f.otherId, statement.id)).rejects.toThrow("不存在");
  await mapping(f.card.id);
  await expect(observeStatementBalance(h.db, f.ownerId, statement.id)).rejects.toThrow("Plaid");
  const future = await make(f.bank.id, "2099-10-01");
  await expect(observeStatementBalance(h.db, f.ownerId, future.id)).rejects.toThrow("今天");
  const foreignStatement = await make(f.wallet.id);
  await expect(observeStatementBalance(h.db, f.ownerId, foreignStatement.id)).rejects.toThrow("汇率");
  expect(await h.db.select().from(journalEntries)).toHaveLength(0);
});
it("cleans only unreferenced legacy workbook uploads across owners without logging names", async () => {
  const folder = join(directory, "legacy");
  await mkdir(folder, { recursive: true });
  const dead = "a".repeat(64),
    kept = "b".repeat(64);
  for (const hash of [dead, kept]) await writeFile(join(folder, `${hash}.xlsx`), "synthetic workbook");
  await writeFile(join(folder, "unrelated.txt"), "keep");
  const log = vi.spyOn(console, "log");
  try {
    await retainFiles(h.db, readEnv());
    await expect(readFile(join(folder, `${dead}.xlsx`))).rejects.toThrow();
    await expect(readFile(join(folder, `${kept}.xlsx`))).rejects.toThrow();
    expect((await readFile(join(folder, "unrelated.txt"))).toString()).toBe("keep");
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});
it("renders only the tile badge and one overview reminder line, manual forms, configured Plaid line, and no inclusion controls or retired navigation", async () => {
  await mapping(f.broker.id, f.security.id);
  const tracking = await accountBalanceTracking(h.db, f.ownerId, today);
  const html = renderToStaticMarkup(
    <AccountsView
      accounts={(await balancesAsOf(h.db, f.ownerId, today)).filter((row) => !row.isSystem)}
      institutions={[]}
      groups={[]}
      today={today}
      tracking={tracking}
    />,
  );
  expect(html.match(/>待更新</g)).toHaveLength(5);
  const controls = (id: string) => (
    <BalanceControls
      account={[f.bank, f.broker, f.security].find((row) => row.id === id)!}
      tracking={tracking.find((row) => row.accountId === id)!}
      today={today}
      timezone="America/Los_Angeles"
      baseCurrency="USD"
      rates={[]}
      syncIntervalHours={24}
    />
  );
  expect(renderToStaticMarkup(controls(f.broker.id))).toContain(
    "Plaid 每 24 小时自动同步 · 上次 2026/10/25 19:00",
  );
  expect(renderToStaticMarkup(controls(f.broker.id))).not.toContain("余额更新提醒");
  const manual = renderToStaticMarkup(controls(f.bank.id));
  for (const text of ["更新余额", "不提醒", "每天", "每 3 天", "每 7 天", "每 14 天", "每 30 天"])
    expect(manual).toContain(text);
  expect(manual).toContain('max="2026-10-25"');
  expect(
    renderToStaticMarkup(
      <BalanceUpdateForm account={f.security} today={today} baseCurrency="USD" rates={[]} />,
    ),
  ).toContain("更新市值");
  expect(
    renderToStaticMarkup(<BalanceUpdateForm account={f.card} today={today} baseCurrency="USD" rates={[]} />),
  ).toContain("欠款填负数，溢缴款填正数");
  for (const account of [undefined, f.bank])
    expect(
      renderToStaticMarkup(<AccountForm account={account} institutions={[]} onSaved={() => {}} />),
    ).not.toMatch(/cashLikeInclusion|financialInclusion|纳入/);
  expect(
    renderToStaticMarkup(
      <NewAccountFields prefix="test" name="Demo" type="asset_cash" currency="USD" last4={null} />,
    ),
  ).not.toMatch(/:cash|:financial|纳入/);
  expect(readNewAccount(new FormData(), "test")).not.toHaveProperty("cashLikeInclusion");
  const navigation = renderToStaticMarkup(<AppNavigation />);
  expect(navigation).not.toMatch(/\/snapshots|\/reconciliation|快照|对账/);
  const wealth = await wealthOverview(h.db, f.ownerId, today, "USD", 7, 7);
  const month = await monthSummary(h.db, f.ownerId, undefined, today, "posted", "USD", 7);
  const backcast = {
    ...(await loadBackcast(h.db, f.ownerId, { from: "2026-10-01", to: today, baseCurrency: "USD" })),
    historyStart: "2026-10-01",
  };
  const home = renderToStaticMarkup(
    <PersonalOverview wealth={wealth} month={month} backcast={backcast} dueBalanceCount={5} />,
  );
  expect(home.match(/5 个账户需要更新余额 → 账户/g)).toHaveLength(1);
  expect(home).not.toMatch(/完整快照|\/snapshots|\/reconciliation/);
  expect(
    renderToStaticMarkup(
      <PersonalOverview wealth={wealth} month={month} backcast={backcast} dueBalanceCount={0} />,
    ),
  ).not.toContain("需要更新余额");
});
