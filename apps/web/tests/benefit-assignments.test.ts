import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { accounts, auditLogs, cardBenefitAssignments, journalEntries, postings } from "@/db/schema";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { setBenefitAssignment } from "@/lib/benefits/assignment-service";
import { setBenefitProfile } from "@/lib/benefits/profile";
import { benefitInput } from "@/lib/benefits/input";
import { benefitOverview } from "@/lib/benefits/queries";
import { createEntry, replaceEntry } from "@/lib/ledger/entries";
import { buildPostings } from "@/lib/ledger/builders";
import { createAccount } from "@/lib/ledger/accounts";
import { createSession } from "@/lib/auth/session";
import { exportOwnerData } from "@/lib/data/export";
import { ownerTables } from "@/lib/data/tables";
const productId = "us-amex-business-platinum";
let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
vi.mock("@/db/client", () => ({ getDb: () => h.db }));
const route = await import("@/app/api/benefits/assignments/route");
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
  await setBenefitProfile(h.db, f.ownerId, { accountId: f.card.id, mode: "product", productId });
});
async function refund(description = "SYNTHETIC BENEFIT", amount = "23", date = "2026-03-10") {
  const input = await benefitInput(h.db, f.ownerId, {
    accountId: f.card.id,
    amount,
    currency: "USD",
    eventDate: date,
    description,
    family: "generic",
  });
  return { input, entry: await createEntry(h.db, f.ownerId, input) };
}
const logs = () =>
  h.db
    .select()
    .from(auditLogs)
    .where(sql`${auditLogs.action} like 'benefit_assignment.%'`)
    .orderBy(auditLogs.createdAt);
const overview = () => benefitOverview(h.db, f.ownerId, "2026-11-20");
async function catalog() {
  const card = (await overview()).cards.find((card) => card.accountId === f.card.id)!;
  if (!card.catalog || card.catalog.stale) throw new Error("Expected synthetic card's selected product");
  return card.catalog;
}
it("sets, changes, excludes and clears idempotently with IDs-only audits and unchanged postings", async () => {
  const { entry } = await refund();
  const before = {
    entries: await h.db.select().from(journalEntries),
    postings: await h.db.select().from(postings),
  };
  const base = { entryId: entry.id, productId };
  for (const creditId of ["dell", "hotel"]) {
    await setBenefitAssignment(h.db, f.ownerId, { ...base, mode: "credit", creditId });
    await setBenefitAssignment(h.db, f.ownerId, { ...base, mode: "credit", creditId });
  }
  for (const mode of ["none", "auto"] as const) {
    await setBenefitAssignment(h.db, f.ownerId, { ...base, mode });
    await setBenefitAssignment(h.db, f.ownerId, { ...base, mode });
  }
  expect(await h.db.select().from(cardBenefitAssignments)).toEqual([]);
  const audit = await logs();
  expect(audit.map((row) => row.action)).toEqual([
    "benefit_assignment.set",
    "benefit_assignment.set",
    "benefit_assignment.none",
    "benefit_assignment.auto",
  ]);
  expect(audit.map((row) => row.changes)).toEqual(
    ["dell", "hotel", null, null].map((creditId) => ({
      entryId: entry.id,
      accountId: f.card.id,
      catalogProductId: productId,
      creditId,
    })),
  );
  expect(await h.db.select().from(journalEntries)).toEqual(before.entries);
  expect(await h.db.select().from(postings)).toEqual(before.postings);
});
it("validates current product and statement-credit membership", async () => {
  const { entry } = await refund();
  const base = { entryId: entry.id, productId, mode: "credit", creditId: "dell" };
  await expect(setBenefitAssignment(h.db, f.ownerId, { ...base, productId: "missing" })).rejects.toThrow(
    "卡产品已更改，请刷新后重试",
  );
  await expect(setBenefitAssignment(h.db, f.ownerId, { ...base, creditId: "missing" })).rejects.toThrow(
    "该报销项目不属于当前卡产品",
  );
  await expect(setBenefitAssignment(h.db, f.ownerId, { ...base, ownerId: f.otherId })).rejects.toThrow();
  await setBenefitProfile(h.db, f.ownerId, { accountId: f.card.id, mode: "none" });
  await expect(setBenefitAssignment(h.db, f.ownerId, base)).rejects.toThrow("卡产品已更改，请刷新后重试");
  await setBenefitProfile(h.db, f.ownerId, {
    accountId: f.card.id,
    mode: "product",
    productId: "us-amex-gold",
  });
  await expect(
    setBenefitAssignment(h.db, f.ownerId, { ...base, productId: "us-amex-gold", creditId: "uber" }),
  ).rejects.toThrow("该报销项目不属于当前卡产品");
  expect(await logs()).toEqual([]);
});
it("isolates owners and rejects non-card postings", async () => {
  const { entry } = await refund();
  await expect(
    setBenefitAssignment(h.db, f.otherId, { entryId: entry.id, productId, mode: "none" }),
  ).rejects.toMatchObject({ status: 404 });
  const bank = await createEntry(
    h.db,
    f.ownerId,
    await buildPostings(h.db, f.ownerId, "refund", {
      toAccountId: f.bank.id,
      categoryId: f.category("其他支出"),
      amount: "3",
      eventDate: "2026-03-10",
      status: "confirmed",
    }),
  );
  await expect(
    setBenefitAssignment(h.db, f.ownerId, { entryId: bank.id, productId, mode: "none" }),
  ).rejects.toThrow("权益退款不存在");
  // A malformed cross-owner posting must still never resolve a foreign account.
  const foreign = await createAccount(h.db, f.otherId, {
    name: "Other Fictional Card",
    type: "liability_credit_card",
    currency: "USD",
  });
  await expect(
    h.db
      .insert(cardBenefitAssignments)
      .values({ ownerId: f.ownerId, accountId: foreign.id, entryId: entry.id, catalogProductId: productId }),
  ).rejects.toThrow();
  await expect(
    h.db
      .insert(cardBenefitAssignments)
      .values({ ownerId: f.otherId, accountId: foreign.id, entryId: entry.id, catalogProductId: productId }),
  ).rejects.toThrow();
});
it.each([
  { benefitCredit: false },
  { status: "draft" as const },
  { status: "voided" as const },
  { entryType: "expense" as const },
  { benefitFamily: "offer" },
  { description: "SYNTHETIC MERCHANT OFFER CREDIT" },
])("rejects ineligible entries: %j", async (changes) => {
  const { entry } = await refund();
  await h.db.update(journalEntries).set(changes).where(eq(journalEntries.id, entry.id));
  await expect(
    setBenefitAssignment(h.db, f.ownerId, { entryId: entry.id, productId, mode: "none" }),
  ).rejects.toThrow("只能归属已确认的权益退款");
});
it("inherits nearest same-product choices through replacements; auto clears the ancestor chain", async () => {
  const { entry, input } = await refund("Dell Credit", "1000");
  await setBenefitAssignment(h.db, f.ownerId, {
    entryId: entry.id,
    productId,
    mode: "credit",
    creditId: "dell",
  });
  const second = await replaceEntry(h.db, f.ownerId, entry.id, input, "Synthetic correction");
  const third = await replaceEntry(h.db, f.ownerId, second.id, input, "Synthetic correction");
  expect((await catalog()).entryAssignments[third.id]).toMatchObject({
    ownerAssigned: true,
    ownerCreditId: "dell",
    automaticCreditId: "dell-spend",
  });
  expect(
    (await catalog()).instances
      .find((instance) => instance.credit === "dell")
      ?.entry_details.map((entry) => entry.id),
  ).toEqual([third.id]);
  await setBenefitAssignment(h.db, f.ownerId, { entryId: third.id, productId, mode: "none" });
  expect((await catalog()).entryAssignments[third.id]).toMatchObject({
    ownerAssigned: true,
    ownerCreditId: null,
  });
  await setBenefitAssignment(h.db, f.ownerId, { entryId: third.id, productId, mode: "auto" });
  expect(await h.db.select().from(cardBenefitAssignments)).toEqual([]);
  expect((await catalog()).entryAssignments[third.id]).toMatchObject({
    ownerAssigned: false,
    automaticCreditId: "dell-spend",
  });
  expect((await logs()).map((row) => row.action)).toEqual([
    "benefit_assignment.set",
    "benefit_assignment.none",
    "benefit_assignment.auto",
  ]);
});
it("ignores old-product assignments and exports only the owner's choices", async () => {
  const { entry } = await refund("Dell Credit");
  await setBenefitAssignment(h.db, f.ownerId, { entryId: entry.id, productId, mode: "none" });
  expect((await catalog()).entryAssignments[entry.id].ownerAssigned).toBe(true);
  await setBenefitProfile(h.db, f.ownerId, {
    accountId: f.card.id,
    mode: "product",
    productId: "us-amex-platinum",
  });
  expect((await catalog()).entryAssignments[entry.id].ownerAssigned).toBe(false);
  expect((await exportOwnerData(h.db, f.ownerId)).tables.card_benefit_assignments).toHaveLength(1);
  expect((await exportOwnerData(h.db, f.otherId)).tables.card_benefit_assignments).toEqual([]);
  expect(Object.keys(ownerTables).indexOf("card_benefit_assignments")).toBeLessThan(
    Object.keys(ownerTables).indexOf("journal_entries"),
  );
});
it("computes Business Platinum matching, qualified caps and expired quarters from synthetic engine inputs", async () => {
  await createEntry(
    h.db,
    f.ownerId,
    await buildPostings(h.db, f.ownerId, "expense", {
      fromAccountId: f.card.id,
      categoryId: f.category("其他支出"),
      amount: "2",
      eventDate: "2026-01-02",
      status: "confirmed",
    }),
  );
  const dell = await refund("BUSINESS PLATINUM DELL TECHNOLOGIES CREDIT", "150", "2026-03-10");
  const spend = await refund("BUSINESS PLATINUM DELL TECHNOLOGIES CREDIT", "1000", "2026-05-02");
  const hilton = await refund("HILTON FOR BUSINESS CREDIT", "50", "2026-02-14");
  const data = await overview();
  const card = data.cards.find((card) => card.accountId === f.card.id)!;
  expect(card.byName).toEqual([]);
  expect(card.annual).toBe("1200.0000");
  const details = await catalog();
  expect(details.entryAssignments[dell.entry.id]).toMatchObject({
    automaticCreditId: "dell",
    source: "fuzzy",
  });
  expect(details.entryAssignments[spend.entry.id]).toMatchObject({
    automaticCreditId: "dell-spend",
    source: "amount",
  });
  expect(details.entryAssignments[hilton.entry.id]).toMatchObject({
    automaticCreditId: "hilton",
    source: "fuzzy",
  });
  expect(details.instances.find((instance) => instance.credit === "dell")).toMatchObject({
    year: { used: "150.0000" },
  });
  expect(details.instances.find((instance) => instance.credit === "dell-spend")).toMatchObject({
    year: { used: "1000.0000" },
  });
  expect(details.instances.find((instance) => instance.credit === "hilton")).toMatchObject({
    year: { cap: "200.0000", used: "50.0000", expired_unused: "100.0000", available: "50.0000" },
    periods: [{ state: "full" }, { state: "unused" }, { state: "unused" }, { state: "unused" }],
  });
  expect(details.annual).toEqual({
    cap: "3649.0000",
    used: "1200.0000",
    expiredUnused: "770.0000",
    remaining: "1679.0000",
    conditionalCap: "3850.0000",
    excluded: { multiYear: 1, untracked: 0 },
  });
});
it("accepts automatic product detection and enforces session/origin on PUT", async () => {
  await setBenefitProfile(h.db, f.ownerId, { accountId: f.card.id, mode: "auto" });
  await h.db
    .update(accounts)
    .set({ name: "American Express Business Platinum" })
    .where(eq(accounts.id, f.card.id));
  const { entry } = await refund();
  const request = (cookie?: string, origin = "http://localhost:3000") =>
    new NextRequest("http://localhost:3000/api/benefits/assignments", {
      method: "PUT",
      headers: {
        host: "localhost:3000",
        origin,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ entryId: entry.id, productId, mode: "credit", creditId: "dell" }),
    });
  expect((await route.PUT(request())).status).toBe(401);
  const session = await createSession(h.db, f.ownerId, { ipHash: "test", userAgent: "synthetic" });
  const cookie = `al_session=${session.token}`;
  expect((await route.PUT(request(cookie, "https://untrusted.example"))).status).toBe(403);
  expect((await route.PUT(request(cookie))).status).toBe(200);
});
