import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { balanceSnapshots, snapshotFx } from "@/db/schema";
import { updateAccount, getSystemAccount } from "@/lib/ledger/accounts";
import { createSnapshot, publishSnapshot } from "@/lib/snapshots/service";
import { accountGroups } from "@/db/schema";
import { observationOverview } from "@/lib/dashboard/observations";
import { dashboardLedger } from "@/lib/dashboard/ledger";
import { createEntry } from "@/lib/ledger/entries";
import { createQuickEntry } from "@/lib/ledger/builders";
import { AppNavigation } from "@/components/app-navigation";
let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
vi.mock("next/navigation", () => ({
  usePathname: () => "/statements",
  useRouter: () => ({ refresh: vi.fn() }),
}));
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
const overview = () => observationOverview(h.db, f.ownerId, "2026-10-24", "USD", 14, 7);
async function observe(
  date: string,
  items: { accountId?: string; accountGroupId?: string; balanceNative: string; currency: string }[],
  source: "manual" | "plaid" = "manual",
  fx: { quoteCurrency: string; rate: string; observedOn: string; source: string }[] = [],
) {
  const snapshot = await createSnapshot(h.db, f.ownerId, {
    snapshotDate: date,
    label: "Synthetic observation",
    items,
    fx,
  });
  await publishSnapshot(h.db, f.ownerId, snapshot.id);
  await h.db.update(balanceSnapshots).set({ source }).where(eq(balanceSnapshots.id, snapshot.id));
  return snapshot;
}
it("combines latest manual/Plaid observations once per account with dates, coverage and stale flags", async () => {
  await observe("2026-10-01", [
    { accountId: f.bank.id, balanceNative: "1000", currency: "USD" },
    { accountId: f.card.id, balanceNative: "-100", currency: "USD" },
    { accountId: f.security.id, balanceNative: "5000", currency: "USD" },
  ]);
  const current = await observe(
    "2026-10-24",
    [{ accountId: f.bank.id, balanceNative: "1200", currency: "USD" }],
    "plaid",
  );
  const result = await overview();
  expect(result.cashLike.value).toBe("1100.0000000000");
  expect(result.cards.value).toBe("100.0000000000");
  expect(result.investments.value).toBe("5000.0000000000");
  expect(result.rows.find((row) => row.key === f.bank.id)).toMatchObject({
    snapshotId: current.id,
    date: "2026-10-24",
    stale: false,
  });
  expect(result.rows.find((row) => row.key === f.card.id)?.stale).toBe(true);
  expect(result.cashLike.missing).toContain(f.broker.name);
  expect((await observationOverview(h.db, f.otherId, "2026-10-24", "USD", 14, 7)).rows).toEqual([]);
});
it("uses each observation's frozen FX and reports missing FX without assuming parity", async () => {
  await updateAccount(h.db, f.ownerId, f.wallet.id, { cashLikeInclusion: true });
  const snapshot = await observe(
    "2026-10-23",
    [{ accountId: f.wallet.id, balanceNative: "670", currency: "CNY" }],
    "manual",
    [{ quoteCurrency: "CNY", rate: "6.7", observedOn: "2026-10-01", source: "Synthetic frozen" }],
  );
  expect((await overview()).cashLike.value).toBe("100.0000000000");
  expect((await overview()).rows[0].staleFx).toBe(true);
  // Model an imported historical observation without rates; the renderer must not invent one.
  await h.db.delete(snapshotFx).where(eq(snapshotFx.snapshotId, snapshot.id));
  expect((await overview()).cashLike.value).toBeNull();
  expect((await overview()).cashLike.missingFx).toContain(f.wallet.name);
});
it("group observations stay a single pseudo-account until all members replace them", async () => {
  const [group] = await h.db
    .insert(accountGroups)
    .values({
      ownerId: f.ownerId,
      name: "Example aggregate",
      currency: "USD",
      cashLikeInclusion: true,
      financialInclusion: true,
    })
    .returning();
  await updateAccount(h.db, f.ownerId, f.bank.id, { accountGroupId: group.id });
  await updateAccount(h.db, f.ownerId, f.broker.id, { accountGroupId: group.id });
  await observe("2026-10-01", [{ accountGroupId: group.id, balanceNative: "2000", currency: "USD" }]);
  await observe("2026-10-20", [{ accountId: f.bank.id, balanceNative: "1200", currency: "USD" }], "plaid");
  expect((await overview()).cashLike.value).toBe("2000.0000000000");
  expect((await overview()).rows).toHaveLength(1);
  await observe("2026-10-21", [{ accountId: f.broker.id, balanceNative: "900", currency: "USD" }]);
  expect((await overview()).cashLike.value).toBe("2100.0000000000");
  expect((await overview()).rows).toHaveLength(2);
});
it("month comparison counts only expense/income postings and reduces spending for refunds", async () => {
  await createQuickEntry(h.db, f.ownerId, {
    type: "expense",
    fromAccountId: f.card.id,
    amount: "100",
    eventDate: "2026-10-10",
    categoryId: f.category("购物"),
  });
  await createQuickEntry(h.db, f.ownerId, {
    type: "refund",
    toAccountId: f.card.id,
    amount: "20",
    eventDate: "2026-10-12",
    categoryId: f.category("购物"),
  });
  await createQuickEntry(h.db, f.ownerId, {
    type: "expense",
    fromAccountId: f.bank.id,
    amount: "40",
    eventDate: "2026-09-10",
    categoryId: f.category("餐饮"),
  });
  await createQuickEntry(h.db, f.ownerId, {
    type: "expense",
    fromAccountId: f.bank.id,
    amount: "999",
    eventDate: "2026-09-30",
    categoryId: f.category("餐饮"),
  });
  await createQuickEntry(h.db, f.ownerId, {
    type: "income",
    toAccountId: f.bank.id,
    amount: "200",
    eventDate: "2026-10-10",
    categoryId: f.category("工资"),
  });
  await createQuickEntry(h.db, f.ownerId, {
    type: "credit_card_payment",
    fromAccountId: f.bank.id,
    toAccountId: f.card.id,
    amount: "100",
    eventDate: "2026-10-15",
  });
  await createQuickEntry(h.db, f.ownerId, {
    type: "transfer",
    fromAccountId: f.bank.id,
    toAccountId: f.broker.id,
    amount: "1000",
    eventDate: "2026-10-15",
  });
  const clearing = await getSystemAccount(h.db, f.ownerId, "transfer_clearing", "USD");
  await createEntry(h.db, f.ownerId, {
    entryType: "transfer",
    status: "confirmed",
    eventDate: "2026-10-15",
    postings: [
      { accountId: f.bank.id, amount: "-50", currency: "USD" },
      { accountId: clearing.id, amount: "50", currency: "USD" },
    ],
  });
  const summary = await dashboardLedger(h.db, f.ownerId, "2026-10-24", "posted");
  expect(summary.spending[0].amount).toBe("80.0000");
  expect(summary.previousSpending[0].amount).toBe("40.0000");
  expect(summary.income[0].amount).toBe("200.0000");
  expect(summary.byCategory).toEqual([{ currency: "USD", group: "购物", amount: "80.0000" }]);
  expect(summary.dailySeries[0].rows).toHaveLength(30);
});
it("empty overview never fabricates observations or spending", async () => {
  const result = await overview();
  expect(result.cashLike.value).toBeNull();
  expect(result.rows).toEqual([]);
  expect(result.missing).toHaveLength(7);
  const ledger = await dashboardLedger(h.db, f.ownerId, "2026-10-24", "posted");
  expect(ledger.spending).toEqual([]);
  expect(ledger.income).toEqual([]);
  expect(ledger.dailySeries).toEqual([]);
});
it("merged navigation has one import item per surface, correct order, and optional badge", () => {
  for (const enabled of [true, false]) {
    const html = renderToStaticMarkup(<AppNavigation plaidEnabled={enabled} pendingCount={4} />);
    expect(html).not.toContain("银行同步");
    expect(html).not.toContain("账单导入");
    expect(html.match(/href="\/statements"/g)).toHaveLength(2);
    expect(html).toContain("4 项待处理");
    expect(html.indexOf("导入与同步")).toBeLessThan(html.indexOf("账户"));
    const mobile = html.slice(html.indexOf('aria-label="移动导航"'));
    expect(mobile).toContain("总览");
    expect(mobile).toContain("流水");
    expect(mobile).toContain("导入与同步");
    expect(mobile).toContain("更多");
  }
  expect(renderToStaticMarkup(<AppNavigation pendingCount={0} />)).not.toContain("项待处理");
});
