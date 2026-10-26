import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { createQuickEntry } from "@/lib/ledger/builders";
import { getEntry, voidEntry } from "@/lib/ledger/entries";
import { listEntries, ledgerOverview } from "@/lib/ledger/queries";
import { filtersSchema, type QuickInput } from "@/lib/ledger/schemas";
import { resolveEntryMatching } from "@/lib/bank-sync/matching";
import { pendingWorkbench } from "@/lib/bank-sync/pending";
import { stampAutoEntry } from "@/lib/bank-sync/auto-state";
import { createSession } from "@/lib/auth/session";
import { monthActivity } from "@/lib/dashboard/activity";
import { RecentEntryRows } from "@/components/ledger/account-recent";
import type { EntryList } from "@/components/ledger/types";

let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
vi.mock("@/db/client", () => ({ getDb: () => h.db }));
vi.mock("@/lib/auth/current-user", () => ({
  requireUser: async () => ({ id: f.ownerId, timezone: "UTC", baseCurrency: "USD" }),
}));
const route = await import("@/app/api/transactions/route");
const { default: Details } = await import("@/app/(app)/dashboard/details/page");
beforeAll(async () => {
  h = await createTestDb();
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("APP_SECRET", "synthetic-activity-drilldown-secret-32-characters");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic/test");
  vi.stubEnv("PLAID_ENABLED", "false");
});
afterAll(async () => {
  await h.client.close();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
});
const quick = (input: Omit<QuickInput, "eventDate"> & { eventDate?: string }) =>
  createQuickEntry(h.db, f.ownerId, { eventDate: "2026-01-12", ...input });
async function request(query: string, ownerId = f.ownerId) {
  const session = await createSession(h.db, ownerId, { ipHash: "synthetic", userAgent: "test" });
  return route.GET(
    new NextRequest(`http://localhost:3000/api/transactions?${query}`, {
      headers: { cookie: `al_session=${session.token}` },
    }),
  );
}
it("hides voided entries by default in totals, pagination, overview and recent auto-posts, while explicit lookup works", async () => {
  const active = await quick({
    type: "expense",
    amount: "12",
    fromAccountId: f.bank.id,
    categoryId: f.category("购物"),
  });
  const draft = await quick({
    type: "expense",
    amount: "13",
    fromAccountId: f.bank.id,
    categoryId: f.category("购物"),
    status: "draft",
  });
  const voided = await quick({
    type: "income",
    amount: "14",
    toAccountId: f.bank.id,
    categoryId: f.category("工资"),
  });
  await stampAutoEntry(h.db, f.ownerId, voided.id);
  await voidEntry(h.db, f.ownerId, voided.id, "Synthetic correction");
  const data = await listEntries(h.db, f.ownerId, { limit: 1 });
  expect(data.total).toBe(2);
  expect(data.entries).toHaveLength(1);
  expect(data.entries[0].id).not.toBe(voided.id);
  expect((await listEntries(h.db, f.ownerId)).entries.map((row) => row.id).sort()).toEqual(
    [active.id, draft.id].sort(),
  );
  expect((await listEntries(h.db, f.ownerId, { status: "voided" })).entries.map((row) => row.id)).toEqual([
    voided.id,
  ]);
  expect((await listEntries(h.db, f.otherId, { status: "voided" })).total).toBe(0);
  expect((await getEntry(h.db, f.ownerId, voided.id)).status).toBe("voided");
  expect(
    (await ledgerOverview(h.db, f.ownerId, "2026-01-31", "posted")).recent.map((row) => row.id),
  ).not.toContain(voided.id);
  expect((await pendingWorkbench(h.db, f.ownerId, "sandbox")).recent.map((row) => row.id)).not.toContain(
    voided.id,
  );
  expect(
    (await (await request("status=voided")).json()).entries.map((row: { id: string }) => row.id),
  ).toEqual([voided.id]);
});
it("account API returns the latest ten confirmed/draft rows, includes the receiving side once, and isolates owners", async () => {
  for (let day = 1; day <= 11; day++)
    await quick({
      type: "expense",
      amount: "1",
      fromAccountId: f.card.id,
      categoryId: f.category("购物"),
      eventDate: `2026-01-${String(day).padStart(2, "0")}`,
    });
  await quick({
    type: "expense",
    amount: "2",
    fromAccountId: f.broker.id,
    categoryId: f.category("购物"),
    eventDate: "2026-01-20",
  });
  const draft = await quick({
    type: "expense",
    amount: "3",
    fromAccountId: f.card.id,
    categoryId: f.category("购物"),
    status: "draft",
    eventDate: "2026-01-13",
  });
  const out = await quick({
    type: "expense",
    amount: "8",
    fromAccountId: f.bank.id,
    categoryId: f.category("其他支出"),
    eventDate: "2026-01-14",
  });
  await resolveEntryMatching(h.db, f.ownerId, out.id, { action: "assign", accountId: f.card.id });
  const response = await request(`accountId=${f.card.id}&limit=10`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const data: EntryList = await response.json();
  expect(data.total).toBe(13);
  expect(data.entries).toHaveLength(10);
  expect(data.entries[0].transfer).toMatchObject({
    from: { accountName: f.bank.name },
    to: { accountName: f.card.name },
    amount: "8.0000",
  });
  expect(data.entries[1].id).toBe(draft.id);
  expect(data.entries.map((row) => row.effectiveDate)).toEqual(
    [...data.entries.map((row) => row.effectiveDate)].sort().reverse(),
  );
  const html = renderToStaticMarkup(<RecentEntryRows entries={data.entries} />);
  expect(html).toContain(`${f.bank.name} → ${f.card.name}`);
  expect(html).toContain("草稿");
  expect(html.match(/href="\/activity\?entryId=/g)).toHaveLength(10);
  expect(html).not.toContain("转账清算");
  expect((await (await request(`accountId=${f.card.id}&limit=10`, f.otherId)).json()).entries).toEqual([]);
  expect((await route.GET(new NextRequest("http://localhost:3000/api/transactions?limit=10"))).status).toBe(
    401,
  );
});
it("income view filters by postings and monthly details include signed contributions, categories and drilldown links", async () => {
  const purchase = await quick({
    type: "expense",
    amount: "20",
    fromAccountId: f.card.id,
    categoryId: f.category("购物"),
    description: "Example purchase",
    eventDate: "2026-01-10",
  });
  const refund = await quick({
    type: "refund",
    amount: "5",
    toAccountId: f.card.id,
    categoryId: f.category("购物"),
    description: "Example refund",
    eventDate: "2026-01-11",
  });
  const fee = await quick({
    type: "investment_buy",
    amount: "50",
    feeAmount: "2",
    fromAccountId: f.broker.id,
    toAccountId: f.security.id,
    feeCategoryId: f.category("手续费"),
    description: "Example purchase fee",
  });
  const salary = await quick({
    type: "income",
    amount: "100",
    toAccountId: f.bank.id,
    categoryId: f.category("工资"),
    description: "Example salary",
  });
  const interest = await quick({
    type: "interest",
    interestDirection: "income",
    amount: "3",
    toAccountId: f.bank.id,
    categoryId: f.category("利息收入"),
    description: "Example interest",
    eventDate: "2026-01-13",
  });
  const transferred = await quick({
    type: "transfer",
    amount: "30",
    fromAccountId: f.bank.id,
    toAccountId: f.broker.id,
  });
  await quick({
    type: "income",
    amount: "40",
    toAccountId: f.bank.id,
    categoryId: f.category("工资"),
    status: "draft",
  });
  const prior = await quick({
    type: "income",
    amount: "7",
    toAccountId: f.bank.id,
    categoryId: f.category("工资"),
    eventDate: "2025-12-31",
    postedDate: "2026-01-02",
  });
  expect(filtersSchema.parse({ view: "income" }).view).toBe("income");
  const window = { from: "2026-01-01", to: "2026-01-31", basis: "event" as const };
  const income = await monthActivity(h.db, f.ownerId, window, "income");
  expect(income.entries.map((row) => row.id).sort()).toEqual([salary.id, interest.id].sort());
  expect(income.entries.find((row) => row.id === interest.id)?.amounts).toEqual({ USD: "3.0000" });
  expect(
    (await monthActivity(h.db, f.ownerId, { ...window, basis: "posted" }, "income")).entries.map(
      (row) => row.id,
    ),
  ).toContain(prior.id);
  const spending = await monthActivity(h.db, f.ownerId, window, "spending");
  expect(spending.entries.map((row) => row.id).sort()).toEqual([purchase.id, refund.id, fee.id].sort());
  expect(spending.entries.find((row) => row.id === refund.id)?.amounts).toEqual({ USD: "-5.0000" });
  expect(spending.entries.find((row) => row.id === fee.id)?.amounts).toEqual({ USD: "2.0000" });
  expect((await monthActivity(h.db, f.otherId, window, "spending")).entries).toEqual([]);
  for (const [view, category, entries] of [
    ["spending", f.category("购物"), spending.entries],
    ["income", f.category("工资"), income.entries],
  ] as const) {
    const page = await Details({ searchParams: Promise.resolve({ view, month: "2026-01", basis: "event" }) });
    const html = renderToStaticMarkup(page);
    expect(html).toContain("本月流水");
    expect(html).toContain("在流水中查看全部 →");
    expect(html).toContain(
      `href="/activity?from=2026-01-01&amp;to=2026-01-31&amp;basis=event&amp;view=${view}&amp;status=confirmed&amp;categoryId=${category}"`,
    );
    for (const entry of entries) expect(html).toContain(`/activity?entryId=${entry.id}`);
    expect(html).not.toContain(`/activity?entryId=${transferred.id}`);
    if (view === "spending") expect(html).toContain("-5.00");
    const api = await request(`from=2026-01-01&to=2026-01-31&basis=event&view=${view}&status=confirmed`);
    expect(api.status).toBe(200);
    expect((await api.json()).entries.map((row: { id: string }) => row.id).sort()).toEqual(
      entries.map((row) => row.id).sort(),
    );
  }
});
it("caps monthly contributions at 100 with an exact count and all-activity link", async () => {
  for (let n = 0; n < 101; n++)
    await quick({ type: "income", amount: "1", toAccountId: f.bank.id, categoryId: f.category("工资") });
  const page = await Details({ searchParams: Promise.resolve({ view: "income", month: "2026-01" }) });
  expect(page.props.activity?.total).toBe(101);
  expect(page.props.activity?.entries).toHaveLength(100);
  const html = renderToStaticMarkup(page);
  expect(html).toContain("显示最近 100 笔，共 101 笔。");
  expect(html).toContain("view=income&amp;status=confirmed");
});
