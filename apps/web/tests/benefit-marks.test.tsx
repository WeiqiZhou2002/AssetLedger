import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import {
  accounts,
  auditLogs,
  bankConnectionAccounts,
  bankConnections,
  cardBenefitMarks,
  cardBenefitProfiles,
  journalEntries,
  postings,
} from "@/db/schema";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { syntheticCatalog } from "./helpers/benefit-catalog";
import { setBenefitMark } from "@/lib/benefits/mark-service";
import { setBenefitProfile } from "@/lib/benefits/profile";
import { benefitOverview } from "@/lib/benefits/queries";
import { benefitInput } from "@/lib/benefits/input";
import { buildPostings } from "@/lib/ledger/builders";
import { createEntry } from "@/lib/ledger/entries";
import { createAccount } from "@/lib/ledger/accounts";
import { createSession } from "@/lib/auth/session";
import { exportOwnerData } from "@/lib/data/export";
import { ownerTables } from "@/lib/data/tables";
import { BenefitDetails, BenefitOverview } from "@/components/benefits/overview";
import { InlineMoney } from "@/components/money-amount";
vi.mock("@/lib/benefits/catalog", async (original) => {
  const catalog = syntheticCatalog();
  catalog.cards[1].aliases = ["OTHER"];
  catalog.cards[0].credits.push({
    ...structuredClone(catalog.cards[0].credits[0]),
    id: "wallet",
    delivery: "issuer_wallet",
  });
  return {
    ...(await original<typeof import("@/lib/benefits/catalog")>()),
    catalog,
    productById: (id: string) => catalog.cards.find((card) => card.id === id),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/db/client", () => ({ getDb: () => h.db }));
const route = await import("@/app/api/benefits/marks/route");
let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
const asOf = "2026-06-15";
const sample = () => {
  const c = syntheticCatalog();
  c.cards[1].aliases = ["OTHER"];
  return c;
};
const overview = (catalog = sample()) => benefitOverview(h.db, f.ownerId, asOf, "2026", catalog);
const markInput = () => ({
  accountId: f.card.id,
  productId: "example-voyager",
  creditId: "coffee",
  periodStart: "2026-06-01",
  periodEnd: "2026-06-30",
  marked: true,
});
const profile = (productId = "example-voyager") =>
  setBenefitProfile(h.db, f.ownerId, { accountId: f.card.id, mode: "product", productId });
const logs = () =>
  h.db
    .select()
    .from(auditLogs)
    .where(sql`${auditLogs.action} like 'benefit_mark.%'`)
    .orderBy(auditLogs.createdAt);
const cardFrom = (data: Awaited<ReturnType<typeof overview>>) =>
  data.cards.find((card) => card.accountId === f.card.id)!;
async function refund(amount = "7", eventDate = "2026-06-02", postedDate?: string) {
  return createEntry(
    h.db,
    f.ownerId,
    await benefitInput(h.db, f.ownerId, {
      accountId: f.card.id,
      currency: "USD",
      amount,
      eventDate,
      postedDate,
      description: "BEANHOUSE CREDIT",
      family: "generic",
    }),
  );
}
beforeAll(async () => {
  h = await createTestDb();
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("APP_SECRET", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic/test");
});
afterAll(async () => {
  await h.client.close();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-16T00:30:00Z"));
});
afterEach(() => vi.useRealTimers());
it("automatically resolves names, honors none and manual, and restores auto", async () => {
  await h.db.update(accounts).set({ name: "Voyager Card 1234" }).where(eq(accounts.id, f.card.id));
  expect(cardFrom(await overview())).toMatchObject({
    productSource: "auto",
    catalog: { productId: "example-voyager" },
  });
  await setBenefitProfile(h.db, f.ownerId, { accountId: f.card.id, mode: "none" });
  await refund();
  const none = cardFrom(await overview());
  expect(none).toMatchObject({ productSource: "none", catalog: null });
  expect(none.byName).toHaveLength(1);
  await profile("example-other");
  expect(cardFrom(await overview())).toMatchObject({
    productSource: "manual",
    catalog: { productId: "example-other" },
  });
  await setBenefitProfile(h.db, f.ownerId, { accountId: f.card.id, mode: "auto" });
  expect(cardFrom(await overview()).productSource).toBe("auto");
});
it.each(["我的旅行卡", "Other Card"])(
  "prioritizes official_name over ledger name %s in overview and marks even when disabled",
  async (name) => {
    await h.db.update(accounts).set({ name }).where(eq(accounts.id, f.card.id));
    const [connection] = await h.db
      .insert(bankConnections)
      .values({
        ownerId: f.ownerId,
        environment: "sandbox",
        plaidItemId: "synthetic-item",
        institutionName: "Example Bank",
        accessTokenEnc: "synthetic-not-a-token",
        importFromDate: "2026-01-01",
      })
      .returning();
    await h.db.insert(bankConnectionAccounts).values({
      ownerId: f.ownerId,
      connectionId: connection.id,
      plaidAccountId: "synthetic-account",
      name: "Other Card",
      officialName: "Voyager Card",
      type: "credit",
      accountId: f.card.id,
      isEnabled: false,
    });
    expect(cardFrom(await overview())).toMatchObject({
      productSource: "auto",
      catalog: { productId: "example-voyager" },
    });
    await setBenefitMark(h.db, f.ownerId, markInput());
    expect(await h.db.select().from(cardBenefitMarks)).toHaveLength(1);
  },
);
it("sets, updates and clears idempotently with only ids and dates audited, leaving ledger unchanged", async () => {
  await profile();
  await refund();
  const before = {
    entries: await h.db.select().from(journalEntries),
    postings: await h.db.select().from(postings),
  };
  await setBenefitMark(h.db, f.ownerId, markInput());
  await setBenefitMark(h.db, f.ownerId, markInput());
  expect(await logs()).toHaveLength(1);
  const changed = { ...markInput(), periodEnd: "2026-07-01" };
  await setBenefitMark(h.db, f.ownerId, changed);
  await setBenefitMark(h.db, f.ownerId, changed);
  expect((await h.db.select().from(cardBenefitMarks))[0].periodEnd).toBe(changed.periodEnd);
  await setBenefitMark(h.db, f.ownerId, { ...changed, marked: false });
  await setBenefitMark(h.db, f.ownerId, { ...changed, marked: false });
  expect(await h.db.select().from(cardBenefitMarks)).toEqual([]);
  const audit = await logs();
  expect(audit.map((row) => row.action)).toEqual([
    "benefit_mark.set",
    "benefit_mark.set",
    "benefit_mark.clear",
  ]);
  for (const [i, row] of audit.entries())
    expect(row.changes).toEqual({
      accountId: f.card.id,
      catalogProductId: "example-voyager",
      creditId: "coffee",
      periodStart: "2026-06-01",
      periodEnd: i === 0 ? "2026-06-30" : "2026-07-01",
    });
  expect(await h.db.select().from(journalEntries)).toEqual(before.entries);
  expect(await h.db.select().from(postings)).toEqual(before.postings);
});
it("rejects stale products after auto-to-manual changes, none and unrecognized cards", async () => {
  await expect(setBenefitMark(h.db, f.ownerId, markInput())).rejects.toThrow("卡产品已更改");
  await h.db.update(accounts).set({ name: "Voyager Card" }).where(eq(accounts.id, f.card.id));
  await setBenefitMark(h.db, f.ownerId, markInput());
  await profile("example-other");
  await expect(setBenefitMark(h.db, f.ownerId, markInput())).rejects.toThrow("卡产品已更改");
  await setBenefitProfile(h.db, f.ownerId, { accountId: f.card.id, mode: "none" });
  await expect(setBenefitMark(h.db, f.ownerId, markInput())).rejects.toThrow("卡产品已更改");
});
it("validates credit, owner-local today and bounds", async () => {
  await profile();
  for (const [change, message] of [
    [{ creditId: "missing" }, "该报销项目不属于当前卡产品"],
    [{ creditId: "wallet" }, "该报销项目不属于当前卡产品"],
    [{ productId: "example-other" }, "卡产品已更改"],
    [{ periodStart: "2026-06-16" }, "周期开始日期不能晚于今天"],
    [{ periodEnd: "2026-05-31" }, "周期结束日期须在开始日期至十年内"],
    [{ periodEnd: "2036-06-02" }, "周期结束日期须在开始日期至十年内"],
  ] as const)
    await expect(setBenefitMark(h.db, f.ownerId, { ...markInput(), ...change })).rejects.toThrow(message);
  await expect(
    setBenefitMark(h.db, f.ownerId, { ...markInput(), periodEnd: "2026-02-30" }),
  ).rejects.toThrow();
  await expect(setBenefitMark(h.db, f.ownerId, { ...markInput(), ownerId: f.otherId })).rejects.toThrow();
  expect(await logs()).toEqual([]);
});
it("isolates owners and rejects non-card accounts and cross-owner foreign keys", async () => {
  await profile();
  await expect(setBenefitMark(h.db, f.otherId, markInput())).rejects.toMatchObject({ status: 404 });
  await expect(
    setBenefitProfile(h.db, f.otherId, { accountId: f.card.id, mode: "none" }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(setBenefitMark(h.db, f.ownerId, { ...markInput(), accountId: f.bank.id })).rejects.toThrow(
    "请选择信用卡账户",
  );
  const other = await createAccount(h.db, f.otherId, {
    name: "Other Synthetic Card",
    type: "liability_credit_card",
    currency: "USD",
  });
  const { productId, creditId, periodStart, periodEnd } = markInput();
  await expect(
    h.db.insert(cardBenefitMarks).values({
      creditId,
      periodStart,
      periodEnd,
      ownerId: f.ownerId,
      accountId: other.id,
      catalogProductId: productId,
    }),
  ).rejects.toThrow();
  await setBenefitMark(h.db, f.ownerId, markInput());
  const own = await exportOwnerData(h.db, f.ownerId),
    foreign = await exportOwnerData(h.db, f.otherId);
  expect(own.tables.card_benefit_marks).toHaveLength(1);
  expect(foreign.tables.card_benefit_marks).toEqual([]);
  expect(Object.keys(ownerTables).indexOf("card_benefit_marks")).toBeLessThan(
    Object.keys(ownerTables).indexOf("accounts"),
  );
});
it("infers tracking from the first confirmed non-opening posting, ignoring retired settings", async () => {
  await profile();
  await h.db.update(cardBenefitProfiles).set({ trackingStart: "2020-01-01" });
  await createEntry(
    h.db,
    f.ownerId,
    await buildPostings(h.db, f.ownerId, "opening_balance", {
      toAccountId: f.card.id,
      amount: "-20",
      eventDate: "2025-01-01",
      status: "confirmed",
    }),
  );
  await createEntry(
    h.db,
    f.ownerId,
    await buildPostings(h.db, f.ownerId, "expense", {
      fromAccountId: f.card.id,
      categoryId: f.category("其他支出"),
      amount: "2",
      eventDate: "2026-01-01",
      status: "draft",
    }),
  );
  let card = cardFrom(await overview());
  expect(card.catalog).toMatchObject({
    instances: [
      {
        periods: [expect.objectContaining({ start: "2026-06-01" }), ...Array(6).fill(expect.anything())],
        year: { cap: "70.0000", expired_unused: "0.0000" },
      },
    ],
  });
  await createEntry(
    h.db,
    f.ownerId,
    await buildPostings(h.db, f.ownerId, "expense", {
      fromAccountId: f.card.id,
      categoryId: f.category("其他支出"),
      amount: "2",
      eventDate: "2026-03-31",
      postedDate: "2026-04-01",
      status: "confirmed",
    }),
  );
  card = cardFrom(await overview());
  expect(card.catalog).toMatchObject({
    instances: [{ year: { cap: "90.0000", expired_unused: "20.0000" } }],
  });
  if (card.catalog && !card.catalog.stale)
    expect(card.catalog.instances[0]).toMatchObject({
      periods: expect.arrayContaining([expect.objectContaining({ start: "2026-04-01" })]),
    });
});
it("overlays current and past periods, recalculates year and tile figures, and ignores other-product marks", async () => {
  await profile();
  await refund("2", "2026-04-02");
  await refund();
  await setBenefitMark(h.db, f.ownerId, {
    ...markInput(),
    periodStart: "2026-04-01",
    periodEnd: "2026-04-30",
  });
  await setBenefitMark(h.db, f.ownerId, markInput());
  let data = await overview(),
    card = cardFrom(data);
  expect(card.catalog).toMatchObject({
    annual: { cap: "90.0000", used: "20.0000" },
    instances: [
      {
        year: { expired_unused: "10.0000", available: "0.0000", used: "20.0000" },
        current_period: {
          marked: true,
          detected_used: "7.0000",
          used: "10.0000",
          remaining: "0.0000",
          state: "full",
          activeMark: { periodStart: "2026-06-01", periodEnd: "2026-06-30" },
        },
      },
    ],
  });
  const html = renderToStaticMarkup(<BenefitOverview data={data} />);
  expect(html).toContain(renderToStaticMarkup(<InlineMoney value="20.0000" currency="USD" />));
  const details = renderToStaticMarkup(<BenefitDetails card={card} year="2026" products={data.products} />);
  expect(details).toContain("已手动标记");
  expect(details).toContain('checked=""');
  expect(details).toContain("标记已报销");
  await profile("example-other");
  data = await overview();
  card = cardFrom(data);
  expect(card.catalog).toMatchObject({ annual: { used: "9.0000" } });
  expect(await h.db.select().from(cardBenefitMarks)).toHaveLength(2);
});
it.each(["anniversary", "anniversary_statement"])(
  "estimates %s over 12 months and overlays active marks",
  async (basis) => {
    await profile();
    await refund("3", "2025-06-15");
    await refund("4", "2025-06-16");
    await refund("2", "2026-06-15");
    await refund("9", "2026-06-16");
    const catalog = sample();
    catalog.cards[0].credits[0].versions[0].reset_basis = basis;
    if (basis === "anniversary_statement") {
      catalog.cards[0].credits[0].versions[0].period = "annual";
      await h.db.update(accounts).set({ openedOn: "2024-04-01" }).where(eq(accounts.id, f.card.id));
    }
    expect(cardFrom(await overview(catalog)).catalog).toMatchObject({
      instances: [
        {
          status: "estimated",
          window: { start: "2025-06-16", end: asOf, cap: "10.00", used: "6.0000", remaining: "4.0000" },
        },
      ],
    });
    await setBenefitMark(h.db, f.ownerId, { ...markInput(), periodStart: asOf, periodEnd: "2027-06-14" });
    const card = cardFrom(await overview(catalog));
    expect(card.catalog).toMatchObject({
      annual: { used: "0.0000", cap: "0.0000" },
      instances: [
        {
          status: "estimated",
          marked: true,
          detected_used: "6.0000",
          window: { used: "10.0000", remaining: "0.0000" },
          activeMark: { periodStart: asOf, periodEnd: "2027-06-14" },
        },
      ],
    });
  },
);
it("overlays an eligible multi-year window without annualizing it", async () => {
  await profile();
  const catalog = sample();
  Object.assign(catalog.cards[0].credits[0].versions[0], {
    period: "multi_year",
    period_years: 4,
    reset_basis: "since_last_credit",
  });
  await setBenefitMark(h.db, f.ownerId, { ...markInput(), periodStart: asOf, periodEnd: "2030-06-14" });
  const card = cardFrom(await overview(catalog));
  expect(card.catalog).toMatchObject({
    annual: { used: "0.0000", cap: "0.0000" },
    instances: [
      {
        eligible: false,
        marked: true,
        window: {
          start: asOf,
          end: "2030-06-14",
          cap: "10.00",
          used: "10.00",
          next_eligible_on: "2030-06-15",
        },
      },
    ],
  });
});
it("renders auto badge, ordered choices and no date inputs or date-settings link", async () => {
  await h.db.update(accounts).set({ name: "Voyager Card" }).where(eq(accounts.id, f.card.id));
  const data = await overview(),
    card = cardFrom(data);
  const html = renderToStaticMarkup(<BenefitDetails card={card} year="2026" products={data.products} />);
  expect(html).toContain("自动匹配</span>");
  expect(html).toContain("自动匹配（Voyager Card）");
  expect(html).toContain("不在目录中，不跟踪");
  expect(html.indexOf('value="auto"')).toBeLessThan(html.indexOf('label="建议产品"'));
  expect(html.indexOf('label="建议产品"')).toBeLessThan(html.indexOf('label="Example Bank"'));
  expect(html.indexOf('label="Example Bank"')).toBeLessThan(html.indexOf('value="none"'));
  expect(html).not.toContain('type="date"');
  expect(html).not.toContain("/accounts#");
  expect(html).not.toContain("跟踪起始日");
  await setBenefitProfile(h.db, f.ownerId, { accountId: f.card.id, mode: "none" });
  expect(
    renderToStaticMarkup(
      <BenefitDetails card={cardFrom(await overview())} year="2026" products={data.products} />,
    ),
  ).not.toContain("<details");
});
it("authenticates and enforces same-origin on the marks route", async () => {
  await profile();
  const request = (cookie?: string, origin = "http://localhost:3000") =>
    new NextRequest("http://localhost:3000/api/benefits/marks", {
      method: "PUT",
      headers: {
        host: "localhost:3000",
        origin,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(markInput()),
    });
  expect((await route.PUT(request())).status).toBe(401);
  const session = await createSession(h.db, f.ownerId, { ipHash: "test", userAgent: "synthetic" });
  const cookie = `al_session=${session.token}`;
  expect((await route.PUT(request(cookie, "https://untrusted.example"))).status).toBe(403);
  expect((await route.PUT(request(cookie))).status).toBe(200);
});
