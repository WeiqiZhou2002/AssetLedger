import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { accounts, auditLogs, cardBenefitProfiles, journalEntries, postings } from "@/db/schema";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { syntheticCatalog } from "./helpers/benefit-catalog";
import { setBenefitProfile } from "@/lib/benefits/profile";
import { benefitOverview } from "@/lib/benefits/queries";
import * as creditMatching from "@/lib/benefits/credit-match";
import { benefitInput } from "@/lib/benefits/input";
import { createEntry } from "@/lib/ledger/entries";
import { createAccount } from "@/lib/ledger/accounts";
import { createSession } from "@/lib/auth/session";
import { ownerTables } from "@/lib/data/tables";
import { exportOwnerData } from "@/lib/data/export";
import { BenefitAmount } from "@/components/benefits/amount";
import { BenefitDetails, BenefitOverview } from "@/components/benefits/overview";
vi.mock("@/lib/benefits/catalog", async (original) => ({
  ...(await original<typeof import("@/lib/benefits/catalog")>()),
  catalog: syntheticCatalog(),
  productById: (id: string) => syntheticCatalog().cards.find((card) => card.id === id),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/db/client", () => ({ getDb: () => h.db }));
const route = await import("@/app/api/benefits/profile/route");
let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
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
});
const profile = (productId: string | null = "example-voyager", accountId = f.card.id) =>
  setBenefitProfile(
    h.db,
    f.ownerId,
    productId ? { accountId, mode: "product", productId } : { accountId, mode: "auto" },
  );
const overview = (catalog = syntheticCatalog()) =>
  benefitOverview(h.db, f.ownerId, "2026-06-15", "2026", catalog);
async function refund(
  description = "BEANHOUSE CREDIT",
  amount = "7",
  eventDate = "2026-06-02",
  postedDate?: string,
) {
  return createEntry(
    h.db,
    f.ownerId,
    await benefitInput(h.db, f.ownerId, {
      accountId: f.card.id,
      amount,
      currency: "USD",
      eventDate,
      postedDate,
      description,
      family: "generic",
    }),
  );
}
it("sets all three modes on an inactive card with narrow audit payloads", async () => {
  await h.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, f.card.id));
  await profile();
  await profile("example-other");
  expect((await h.db.select().from(cardBenefitProfiles))[0]).toMatchObject({
    catalogProductId: "example-other",
  });
  await setBenefitProfile(h.db, f.ownerId, { accountId: f.card.id, mode: "none" });
  expect((await h.db.select().from(cardBenefitProfiles))[0].catalogProductId).toBeNull();
  await profile(null);
  expect(await h.db.select().from(cardBenefitProfiles)).toEqual([]);
  const logs = await h.db
    .select()
    .from(auditLogs)
    .where(sql`${auditLogs.action} like 'benefit_profile.%'`)
    .orderBy(auditLogs.createdAt);
  expect(logs.map((log) => log.action)).toEqual([
    "benefit_profile.set",
    "benefit_profile.set",
    "benefit_profile.none",
    "benefit_profile.auto",
  ]);
  expect(logs.map((log) => log.changes)).toEqual([
    { accountId: f.card.id, mode: "product", catalogProductId: "example-voyager" },
    { accountId: f.card.id, mode: "product", catalogProductId: "example-other" },
    { accountId: f.card.id, mode: "none", catalogProductId: null },
    { accountId: f.card.id, mode: "auto", catalogProductId: null },
  ]);
});
it("does not update or audit unchanged auto, product or none choices", async () => {
  const logs = () =>
    h.db
      .select()
      .from(auditLogs)
      .where(sql`${auditLogs.action} like 'benefit_profile.%'`)
      .orderBy(auditLogs.createdAt);
  await profile(null);
  expect(await logs()).toEqual([]);
  await profile();
  const storedProduct = await h.db.select().from(cardBenefitProfiles);
  await profile();
  expect(await h.db.select().from(cardBenefitProfiles)).toEqual(storedProduct);
  expect(await logs()).toHaveLength(1);
  await setBenefitProfile(h.db, f.ownerId, { accountId: f.card.id, mode: "none" });
  const storedNone = await h.db.select().from(cardBenefitProfiles);
  await setBenefitProfile(h.db, f.ownerId, { accountId: f.card.id, mode: "none" });
  expect(await h.db.select().from(cardBenefitProfiles)).toEqual(storedNone);
  expect(await logs()).toHaveLength(2);
  await profile(null);
  await profile(null);
  expect(await h.db.select().from(cardBenefitProfiles)).toEqual([]);
  expect((await logs()).map((log) => log.action)).toEqual([
    "benefit_profile.set",
    "benefit_profile.none",
    "benefit_profile.auto",
  ]);
});
it("rejects foreign, non-card and system accounts, unknown products, invalid dates and extra fields", async () => {
  const other = await createAccount(h.db, f.otherId, {
    name: "Other Demo Card",
    type: "liability_credit_card",
    currency: "USD",
  });
  for (const accountId of [other.id, f.bank.id, f.expense.id])
    await expect(profile("example-voyager", accountId)).rejects.toThrow();
  await expect(profile("missing-product")).rejects.toThrow("卡产品不在当前目录中");
  await expect(
    setBenefitProfile(h.db, f.ownerId, {
      accountId: f.card.id,
      mode: "product",
      productId: "example-voyager",
      trackingStart: "2026-02-30",
    }),
  ).rejects.toThrow();
  await expect(
    setBenefitProfile(h.db, f.ownerId, {
      accountId: f.card.id,
      mode: "product",
      productId: "example-voyager",
      ownerId: f.otherId,
    }),
  ).rejects.toThrow();
  await expect(
    h.db
      .insert(cardBenefitProfiles)
      .values({ ownerId: f.ownerId, accountId: other.id, catalogProductId: "example-voyager" }),
  ).rejects.toThrow();
  expect(await h.db.select().from(cardBenefitProfiles)).toEqual([]);
});
it("keeps totals and ledger records unchanged while matched credits leave other groups", async () => {
  const matched = await refund();
  await refund("MYSTERY CREDIT", "3");
  await refund("BEANHOUSE CREDIT", "9", "2026-07-01");
  const before = (await overview()).cards.find((card) => card.accountId === f.card.id)!;
  const ledgerBefore = await h.db.select().from(journalEntries),
    postingsBefore = await h.db.select().from(postings);
  await profile();
  const data = await overview(),
    card = data.cards.find((card) => card.accountId === f.card.id)!;
  expect(card.annual).toBe(before.annual);
  expect(card.rolling).toBe(before.rolling);
  expect(card.annual).toBe("10.0000");
  expect(card.byName.flatMap((group) => group.entries).map((entry) => entry.id)).not.toContain(matched.id);
  expect(card.byName.flatMap((group) => group.entries)).toHaveLength(1);
  expect(card.families.flatMap((group) => group.entries)).toHaveLength(1);
  expect(card.catalog).toMatchObject({
    productId: "example-voyager",
    reimbursed: { coffee: "7.0000" },
    instances: [{ latest_entry: { id: matched.id } }],
  });
  expect(await h.db.select().from(journalEntries)).toEqual(ledgerBefore);
  expect(await h.db.select().from(postings)).toEqual(postingsBefore);
  expect(data.cards.find((card) => card.accountId !== f.card.id)?.catalog ?? null).toBeNull();
});
it("uses booking dates, estimates missing account dates and retains stale profiles", async () => {
  await refund("BEANHOUSE CREDIT", "7", "2026-05-31", "2026-06-01");
  await profile();
  const catalog = syntheticCatalog();
  catalog.cards[0].credits[0].versions[0].reset_basis = "anniversary";
  expect((await overview(catalog)).cards[0].catalog).toMatchObject({
    instances: [
      {
        status: "estimated",
        window: { start: "2025-06-16", end: "2026-06-15", used: "7.0000", remaining: "3.0000" },
        entry_details: [{ date: "2026-06-01" }],
      },
    ],
  });
  await h.db
    .update(cardBenefitProfiles)
    .set({ catalogProductId: "removed-product" })
    .where(eq(cardBenefitProfiles.ownerId, f.ownerId));
  const stale = (await overview()).cards[0];
  expect(stale.catalog).toEqual({ productId: "removed-product", stale: true });
  expect(stale.byName).toHaveLength(1);
  const staleHtml = renderToStaticMarkup(<BenefitDetails card={stale} year="2026" />);
  expect(staleHtml).toContain("已选卡产品不在当前目录中，请重新选择。");
  expect(staleHtml).toContain("<form");
  expect(staleHtml).toContain('<option value="auto" selected="">');
  expect(staleHtml).not.toContain("已选产品（不在目录中）");
  expect(staleHtml).not.toContain('<option value="removed-product"');
  expect(staleHtml).not.toContain("（更改）");
});
it.each(["no_effective_version", "currency_mismatch"])(
  "shows the final automatic label when the engine rejects a pre-pass candidate: %s",
  async (reason) => {
    await profile();
    const entry = await refund();
    const catalog = syntheticCatalog();
    const product = catalog.cards[0];
    const credit = product.credits[0];
    if (reason === "no_effective_version") credit.versions[0].effective_from = "2026-07-01";
    else product.currency = "EUR";
    const matchBenefitCredits = creditMatching.matchBenefitCredits;
    const prepass = vi.spyOn(creditMatching, "matchBenefitCredits");
    // The pre-pass is advisory; final validation must override a stale recommendation.
    prepass.mockImplementationOnce((input, assignments) => {
      const result = matchBenefitCredits(input, assignments);
      result.matches[entry.id].automaticCreditId = credit.id;
      result.matches[entry.id].source = "keyword";
      return result;
    });
    try {
      const data = await overview(catalog);
      const card = data.cards.find((card) => card.accountId === f.card.id)!;
      expect(card.byName.flatMap((group) => group.entries).map((entry) => entry.id)).toContain(entry.id);
      expect(card.catalog).toMatchObject({
        entryAssignments: {
          [entry.id]: { automaticCreditId: null, source: null, ownerAssigned: false },
        },
      });
      const html = renderToStaticMarkup(<BenefitDetails card={card} year={data.year} />);
      expect(html).toContain("自动匹配（其他权益）");
      expect(html).not.toContain(`自动匹配（${credit.name}）`);
    } finally {
      prepass.mockRestore();
    }
  },
);
it("exports profiles through the owner inventory with children before accounts", async () => {
  await profile();
  const data = await exportOwnerData(h.db, f.ownerId);
  expect(data.tables.card_benefit_profiles).toHaveLength(1);
  expect(Object.keys(ownerTables).indexOf("card_benefit_profiles")).toBeLessThan(
    Object.keys(ownerTables).indexOf("accounts"),
  );
  const other = await exportOwnerData(h.db, f.otherId);
  expect(other.tables.card_benefit_profiles).toEqual([]);
});
it("renders reimbursement status, periods, estimates, informational credits and other benefits", async () => {
  await profile();
  await refund();
  await refund("MYSTERY CREDIT", "2");
  const catalog = syntheticCatalog(),
    credits = catalog.cards[0].credits,
    base = credits[0];
  base.versions[0].conditions = {
    minimum_spend: { amount: "20", period: "transaction" },
    minimum_nights: 2,
    consecutive_months: 3,
  };
  for (const [id, basis, status] of [
    ["anniversary", "anniversary", "verified"],
    ["statement", "anniversary_statement", "verified"],
    ["pending", "calendar", "to_verify"],
    ["unsupported", "future", "verified"],
  ] as const) {
    const credit = structuredClone(base);
    credit.id = id;
    credit.name = `${id} Credit`;
    credit.match.keywords = [id];
    credit.family = undefined;
    credit.versions[0] = {
      ...credit.versions[0],
      period: "annual",
      reset_basis: basis,
      status,
      amount: status === "to_verify" ? null : "100",
    };
    credits.push(credit);
  }
  credits.push({ ...structuredClone(base), id: "wallet", name: "Example Wallet", delivery: "issuer_wallet" });
  const data = await overview(catalog),
    card = data.cards[0];
  const html = renderToStaticMarkup(<BenefitDetails card={card} year={data.year} products={data.products} />);
  const productDisclosure = html.match(
    /<details([^>]*)><summary[^>]*>卡产品：Voyager Card[\s\S]*?<\/summary>[\s\S]*?<form/,
  );
  expect(productDisclosure).not.toBeNull();
  expect(productDisclosure![1]).not.toMatch(/\bopen\b/);
  for (const text of [
    "卡产品",
    "权益报销",
    "本期部分使用",
    "2026-06-02",
    "2026-06-01 至 2026-06-30",
    "需登记",
    "需满足条件",
    "单笔消费满",
    "至少 2 晚",
    "连续 3 个月",
    "卡年度未知，按近 12 个月估算",
    "条款待核实",
    "周期规则暂不支持",
    "不在账单上入账",
    "目录外的权益返还 · 1 笔",
    "CardFacts synthetic-v1（草案）",
    'rel="noreferrer"',
    "Mystery Credit",
    "/activity?entryId=",
  ])
    expect(html).toContain(text);
  expect(renderToStaticMarkup(<BenefitOverview data={data} />)).toContain("已报销");
  await h.db.update(accounts).set({ openedOn: "2024-03-15" }).where(eq(accounts.id, f.card.id));
  const updated = await overview(catalog);
  expect(
    renderToStaticMarkup(<BenefitDetails card={updated.cards[0]} year="2026" products={updated.products} />),
  ).toContain("卡年度未知，按近 12 个月估算");
  expect(html).not.toContain('type="date"');
  expect(html).not.toContain("/accounts#account-");
});
it("keeps the product form expanded without a selected product", async () => {
  const data = await overview();
  const html = renderToStaticMarkup(
    <BenefitDetails card={data.cards[0]} year={data.year} products={data.products} />,
  );
  expect(html).toContain("<form");
  expect(html).not.toContain("<details");
});
it.each(["unsupported", "to_verify", "multi_year"] as const)(
  "shows actual annual refunds on the tile when only %s credits exist",
  async (kind) => {
    await profile();
    await refund();
    const catalog = syntheticCatalog();
    const version = catalog.cards[0].credits[0].versions[0];
    if (kind === "unsupported") version.reset_basis = "future_basis";
    else if (kind === "to_verify") {
      version.status = "to_verify";
      version.amount = null;
    } else {
      version.period = "multi_year";
      version.period_years = 4;
      version.reset_basis = "since_last_credit";
    }
    const data = await overview(catalog),
      card = data.cards[0];
    expect(card.catalog).toMatchObject({ reimbursed: { coffee: "7.0000" } });
    expect(card.annual).toBe("7.0000");
    const html = renderToStaticMarkup(<BenefitOverview data={data} />);
    expect(html).toContain("2026 年已报销");
    expect(html).toContain(
      renderToStaticMarkup(<BenefitAmount value={card.annual} currency={card.currency} large />),
    );
  },
);
it("requires authentication and same-origin PUT, and accepts a valid profile update", async () => {
  const body = { accountId: f.card.id, mode: "product", productId: "example-voyager" };
  const request = (cookie?: string, origin = "http://localhost:3000") =>
    new NextRequest("http://localhost:3000/api/benefits/profile", {
      method: "PUT",
      headers: {
        host: "localhost:3000",
        origin,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  expect((await route.PUT(request())).status).toBe(401);
  const session = await createSession(h.db, f.ownerId, { ipHash: "test", userAgent: "synthetic" });
  const cookie = `al_session=${session.token}`;
  expect((await route.PUT(request(cookie, "https://untrusted.example"))).status).toBe(403);
  expect((await route.PUT(request(cookie))).status).toBe(200);
  expect(
    await h.db
      .select()
      .from(cardBenefitProfiles)
      .where(and(eq(cardBenefitProfiles.ownerId, f.ownerId), eq(cardBenefitProfiles.accountId, f.card.id))),
  ).toHaveLength(1);
});
