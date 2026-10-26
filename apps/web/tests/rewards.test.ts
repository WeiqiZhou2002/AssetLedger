import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import {
  auditLogs,
  loyaltyAccounts,
  loyaltyCppHistory,
  journalEntries,
  loyaltyEvents,
  loyaltyObservations,
  loyaltyPrograms,
  loyaltyTransfers,
  statements,
} from "@/db/schema";
import {
  createEvent,
  createObservation,
  listPrograms,
  saveLoyaltyAccount,
  setCpp,
  transferPoints,
  saveProgram,
} from "@/lib/rewards/service";
import { deleteLoyaltyAccount, previewLoyaltyAccountDelete } from "@/lib/rewards/delete";
import { rewardsOverview } from "@/lib/rewards/queries";
import { confirmStatementRewards, statementRewardsPreview } from "@/lib/rewards/integrations";
import { accountBalance, spendingSummary } from "@/lib/ledger/queries";
import { createQuickEntry } from "@/lib/ledger/builders";
import { money } from "@/lib/money";
import { pointsSchema } from "@/lib/rewards/schemas";
let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
let programs: Awaited<ReturnType<typeof listPrograms>>;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.client.close();
});
beforeEach(async () => {
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
  programs = await listPrograms(h.db, f.ownerId);
});
const program = (code: string) => programs.find((row) => row.code === code)!;
const account = (code: string, name = `${code} Synthetic`, linkedCardAccountId?: string) =>
  saveLoyaltyAccount(h.db, f.ownerId, { programId: program(code).id, name, linkedCardAccountId });
const overview = (date = "2026-10-24") => rewardsOverview(h.db, f.ownerId, date);
const event = (id: string, delta: string, date = "2026-10-01", type = "earn") =>
  createEvent(h.db, f.ownerId, { loyaltyAccountId: id, eventDate: date, pointsDelta: delta, type });
it("AA 100,000 at 1.5 then 1.2 CPP changes only reference value, and selects rules as of date", async () => {
  const aa = await account("AA");
  await createQuickEntry(h.db, f.ownerId, {
    type: "opening_balance",
    toAccountId: f.bank.id,
    amount: "125",
    eventDate: "2026-09-01",
  });
  const before = await accountBalance(h.db, f.ownerId, f.bank.id, "2026-10-24", "posted");
  await event(aa.id, "100000");
  expect((await overview()).accounts[0]).toMatchObject({ points: "100000", valuation: { personal: "1500" } });
  await setCpp(h.db, f.ownerId, {
    programId: aa.programId,
    effectiveDate: "2026-10-20",
    cppBaseline: "1",
    cppPersonal: "1.2",
  });
  expect((await overview("2026-10-19")).accounts[0].valuation?.personal).toBe("1500");
  expect((await overview()).accounts[0]).toMatchObject({ points: "100000", valuation: { personal: "1200" } });
  expect(await accountBalance(h.db, f.ownerId, f.bank.id, "2026-10-24", "posted")).toEqual(before);
  expect(await h.db.select().from(journalEntries)).toHaveLength(1);
});
it("atomic ratio transfers affect only independent programs; no ledger entries or spending", async () => {
  const mr = await account("MR");
  const vs = await account("VS");
  const ana = await account("ANA");
  await event(mr.id, "50000");
  const result = await transferPoints(h.db, f.ownerId, {
    fromAccountId: mr.id,
    toAccountId: vs.id,
    fromPoints: "20000",
    toPoints: "26000",
    eventDate: "2026-10-02",
  });
  expect(result.transfer).toMatchObject({ ratioFrom: 20000n, ratioTo: 26000n });
  expect(result.from.pointsDelta).toBe(-20000n);
  expect(result.to.pointsDelta).toBe(26000n);
  const data = await overview();
  expect(data.accounts.find((row) => row.id === mr.id)?.points).toBe("30000");
  expect(data.accounts.find((row) => row.id === vs.id)?.points).toBe("26000");
  expect(data.accounts.find((row) => row.id === ana.id)?.points).toBe("0");
  expect(await h.db.select().from(journalEntries)).toHaveLength(0);
  expect(
    await spendingSummary(h.db, f.ownerId, {
      from: "2026-10-01",
      to: "2026-10-24",
      basis: "posted",
      groupBy: "category",
    }),
  ).toEqual([]);
  expect(await h.db.select().from(loyaltyTransfers)).toHaveLength(1);
  await expect(
    transferPoints(h.db, f.ownerId, {
      fromAccountId: mr.id,
      toAccountId: f.otherId,
      fromPoints: "100",
      toPoints: "100",
      eventDate: "2026-10-03",
    }),
  ).rejects.toThrow("不存在");
  expect(await h.db.select().from(loyaltyEvents)).toHaveLength(3);
});
it("quantity and CPP effects sum exactly for baseline and personal values", async () => {
  const aa = await account("AA");
  await event(aa.id, "100003", "2026-09-01");
  await event(aa.id, "777", "2026-10-02");
  await setCpp(h.db, f.ownerId, {
    programId: aa.programId,
    effectiveDate: "2026-10-15",
    cppBaseline: "1.1111",
    cppPersonal: "1.2345",
  });
  const data = (await overview()).accounts[0];
  for (const basis of ["baseline", "personal"] as const) {
    const result = data.decomposition![basis];
    expect(money("0").plus(result.quantityEffect).plus(result.cppEffect).eq(result.totalChange)).toBe(true);
  }
  expect(data.decomposition?.personal.quantityEffect).toBe("11.655");
});
it("end-of-day observations anchor balance and expose difference without creating adjustment events", async () => {
  const aa = await account("AA");
  await createObservation(h.db, f.ownerId, {
    loyaltyAccountId: aa.id,
    observedOn: "2026-10-01",
    balance: "1000",
  });
  await event(aa.id, "250", "2026-10-01");
  await event(aa.id, "100", "2026-10-10");
  await createObservation(h.db, f.ownerId, {
    loyaltyAccountId: aa.id,
    observedOn: "2026-10-10",
    balance: "1080",
  });
  await event(aa.id, "-30", "2026-10-11", "redeem");
  const data = (await overview()).accounts[0];
  expect(data.points).toBe("1050");
  expect(data.reconciliation[1]).toMatchObject({ expected: "1100", difference: "20" });
  expect(data.reconciliation[1].eventIds).toHaveLength(1);
  expect(data.earned).toBe("350");
  expect(data.redeemed).toBe("30");
  expect(await h.db.select().from(loyaltyEvents)).toHaveLength(3);
});
async function cardStatement(earned = "1870") {
  const [statement] = await h.db
    .insert(statements)
    .values({
      ownerId: f.ownerId,
      accountId: f.card.id,
      fileSha256: "a".repeat(64),
      originalFilename: "Synthetic.pdf",
      mime: "application/pdf",
      sizeBytes: 100,
      status: "approved",
      statementType: "credit_card",
      summary: { rewards: { earned, total: "45000", as_of: "2026-10-20" } },
    })
    .returning();
  return statement;
}
it("statement rewards require explicit consent and a linked account; confirmation is idempotent", async () => {
  const alt = await account("ALTITUDE", "Synthetic Card Points", f.card.id);
  const statement = await cardStatement();
  expect((await statementRewardsPreview(h.db, f.ownerId, statement.id))?.accounts[0].id).toBe(alt.id);
  await expect(
    confirmStatementRewards(h.db, f.ownerId, statement.id, { loyaltyAccountId: alt.id }),
  ).rejects.toThrow();
  const first = await confirmStatementRewards(h.db, f.ownerId, statement.id, {
    loyaltyAccountId: alt.id,
    confirmed: true,
  });
  const again = await confirmStatementRewards(h.db, f.ownerId, statement.id, {
    loyaltyAccountId: alt.id,
    confirmed: true,
  });
  expect(again.id).toBe(first.id);
  expect(await h.db.select().from(loyaltyEvents)).toHaveLength(1);
  expect(await h.db.select().from(loyaltyObservations)).toHaveLength(1);
  expect((await overview()).accounts[0].points).toBe("45000");
  await expect(
    confirmStatementRewards(h.db, f.otherId, statement.id, { loyaltyAccountId: alt.id, confirmed: true }),
  ).rejects.toThrow("不存在");
});
it("zero earned statements still create exactly one observation; collisions rollback the earn event", async () => {
  const alt = await account("ALTITUDE", "Card Points", f.card.id);
  const statement = await cardStatement("0");
  for (let i = 0; i < 2; i++)
    await confirmStatementRewards(h.db, f.ownerId, statement.id, {
      loyaltyAccountId: alt.id,
      confirmed: true,
    });
  expect(await h.db.select().from(loyaltyEvents)).toHaveLength(0);
  await h.db
    .update(statements)
    .set({ summary: { rewards: { earned: "100", total: "45100", as_of: "2026-10-20" } } })
    .where(eq(statements.id, statement.id));
  const [other] = await h.db
    .insert(statements)
    .values({
      ...statement,
      id: undefined,
      fileSha256: "b".repeat(64),
      summary: { rewards: { earned: "100", total: "45100", as_of: "2026-10-20" } },
    })
    .returning();
  await expect(
    confirmStatementRewards(h.db, f.ownerId, other.id, { loyaltyAccountId: alt.id, confirmed: true }),
  ).rejects.toThrow();
  expect(await h.db.select().from(loyaltyEvents)).toHaveLength(0);
});

it("seed is stable, owner editable, independent and strings protect large integers", async () => {
  await saveProgram(h.db, f.ownerId, { name: "My independent ANA", isArchived: true }, program("ANA").id);
  await listPrograms(h.db, f.ownerId);
  expect(
    await h.db.select().from(loyaltyPrograms).where(eq(loyaltyPrograms.ownerId, f.ownerId)),
  ).toHaveLength(15);
  expect((await listPrograms(h.db, f.ownerId)).find((row) => row.code === "ANA")?.name).toBe(
    "My independent ANA",
  );
  expect((await listPrograms(h.db, f.ownerId)).find((row) => row.code === "ANA")?.unitLabel).toBe("里程");
  const aa = await account("AA");
  await event(aa.id, "9007199254740993");
  expect((await overview()).accounts[0].points).toBe("9007199254740993");
  for (const invalid of [1, "1.2", "NaN", "9223372036854775808", "abc"])
    expect(pointsSchema.safeParse(invalid).success).toBe(false);
  await expect(
    createEvent(h.db, f.otherId, {
      loyaltyAccountId: aa.id,
      pointsDelta: "100",
      eventDate: "2026-10-20",
      type: "earn",
    }),
  ).rejects.toThrow("不存在");
  await expect(event(aa.id, "10", "2026-10-21", "redeem")).rejects.toThrow("负数");
  expect(
    await h.db
      .select()
      .from(loyaltyEvents)
      .where(and(eq(loyaltyEvents.ownerId, f.ownerId), eq(loyaltyEvents.loyaltyAccountId, aa.id))),
  ).toHaveLength(1);
});
it("points and CPP never change financial wealth or cash flow", async () => {
  const { loadDemoLedger } = await import("../../../fixtures/demo/demo-ledger");
  const { wealthOverview } = await import("@/lib/dashboard/wealth");
  await loadDemoLedger(h.db, f.ownerId);
  const wealth = () => wealthOverview(h.db, f.ownerId, "2026-10-24", "USD", 7, 7);
  const before = await wealth();
  const aa = await account("AA");
  await event(aa.id, "100000");
  await setCpp(h.db, f.ownerId, {
    programId: aa.programId,
    effectiveDate: "2026-10-20",
    cppBaseline: "1",
    cppPersonal: "1.2",
  });
  expect(await wealth()).toEqual(before);
});

it("initializes only the program catalog and CPP; repeated reads and statement previews create no accounts", async () => {
  const statement = await cardStatement();
  for (let i = 0; i < 2; i++) {
    const data = await overview();
    expect(data.accounts).toEqual([]);
    expect(data.totalBaseline).toBe("0");
    expect(data.programs).toHaveLength(15);
    expect(data.history).toHaveLength(15);
    expect((await statementRewardsPreview(h.db, f.ownerId, statement.id))?.accounts).toEqual([]);
  }
  expect(await h.db.select().from(loyaltyAccounts)).toEqual([]);
});

it.each(["from", "to"])(
  "deleting the %s side removes whole transfers and opposite events with exact counts and owner isolation",
  async (side) => {
    const mr = await account("MR");
    const aa = await account("AA");
    await event(mr.id, "9007199254740993");
    await event(aa.id, "500");
    await createObservation(h.db, f.ownerId, {
      loyaltyAccountId: mr.id,
      observedOn: "2026-09-01",
      balance: "0",
    });
    await createObservation(h.db, f.ownerId, {
      loyaltyAccountId: aa.id,
      observedOn: "2026-09-01",
      balance: "0",
    });
    await transferPoints(h.db, f.ownerId, {
      fromAccountId: mr.id,
      toAccountId: aa.id,
      fromPoints: "100",
      toPoints: "125",
      eventDate: "2026-10-02",
    });
    const otherPrograms = await listPrograms(h.db, f.otherId);
    const foreignA = await saveLoyaltyAccount(h.db, f.otherId, {
      programId: otherPrograms[0].id,
      name: "Other A",
    });
    const foreignB = await saveLoyaltyAccount(h.db, f.otherId, {
      programId: otherPrograms[0].id,
      name: "Other B",
    });
    await createObservation(h.db, f.otherId, {
      loyaltyAccountId: foreignA.id,
      observedOn: "2026-09-01",
      balance: "200",
    });
    await transferPoints(h.db, f.otherId, {
      fromAccountId: foreignA.id,
      toAccountId: foreignB.id,
      fromPoints: "20",
      toPoints: "25",
      eventDate: "2026-10-02",
    });
    const foreignBefore = await rewardsOverview(h.db, f.otherId, "2026-10-24");
    const target = side === "from" ? mr : aa;
    const survivor = side === "from" ? aa : mr;
    const counts = { events: 3, observations: 1, transfers: 1, otherAccountEvents: 1 };
    expect(await previewLoyaltyAccountDelete(h.db, f.ownerId, target.id)).toEqual(counts);
    await expect(previewLoyaltyAccountDelete(h.db, f.otherId, target.id)).rejects.toThrow("不存在");
    await expect(deleteLoyaltyAccount(h.db, f.otherId, target.id, counts)).rejects.toThrow("不存在");
    expect(await deleteLoyaltyAccount(h.db, f.ownerId, target.id, counts)).toEqual(counts);
    const data = await overview();
    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0]).toMatchObject({
      id: survivor.id,
      points: side === "from" ? "500" : "9007199254740993",
    });
    expect(data.accounts[0].events).toHaveLength(1);
    expect(data.accounts[0].observations).toHaveLength(1);
    expect(data.transfers).toEqual([]);
    expect(
      await h.db.select().from(loyaltyCppHistory).where(eq(loyaltyCppHistory.ownerId, f.ownerId)),
    ).toHaveLength(15);
    expect(await rewardsOverview(h.db, f.otherId, "2026-10-24")).toEqual(foreignBefore);
    const [audit] = await h.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.ownerId, f.ownerId), eq(auditLogs.action, "loyalty.account.delete")));
    expect(audit).toMatchObject({ entityId: target.id, changes: counts });
    expect(Object.values(audit.changes!)).toEqual(Object.values(counts));
  },
);

it("rejects stale deletion counts without changing records, then can delete and explicitly recreate an account", async () => {
  const aa = await account("AA");
  const preview = await previewLoyaltyAccountDelete(h.db, f.ownerId, aa.id);
  expect(preview).toEqual({ events: 0, observations: 0, transfers: 0, otherAccountEvents: 0 });
  await event(aa.id, "50");
  await expect(deleteLoyaltyAccount(h.db, f.ownerId, aa.id, preview)).rejects.toThrow("关联记录已变化");
  expect((await overview()).accounts[0].points).toBe("50");
  const current = await previewLoyaltyAccountDelete(h.db, f.ownerId, aa.id);
  await deleteLoyaltyAccount(h.db, f.ownerId, aa.id, current);
  expect((await overview()).accounts).toEqual([]);
  expect((await overview()).accounts).toEqual([]);
  const recreated = await account("AA");
  expect(recreated.id).not.toBe(aa.id);
  expect((await overview()).accounts[0].points).toBe("0");
});

it("explicitly adding an archived program's account restores it atomically after its last account was deleted", async () => {
  const aa = await account("AA");
  await saveProgram(h.db, f.ownerId, { isArchived: true }, aa.programId);
  await deleteLoyaltyAccount(
    h.db,
    f.ownerId,
    aa.id,
    await previewLoyaltyAccountDelete(h.db, f.ownerId, aa.id),
  );
  await expect(
    saveLoyaltyAccount(h.db, f.otherId, { programId: aa.programId, name: "Other" }),
  ).rejects.toThrow("不存在");
  await expect(account("AA", "Invalid", f.otherId)).rejects.toThrow("不存在");
  expect((await listPrograms(h.db, f.ownerId)).find((row) => row.id === aa.programId)?.isArchived).toBe(true);
  const restored = await account("AA");
  const data = await overview();
  expect(data.accounts).toHaveLength(1);
  expect(data.accounts[0]).toMatchObject({ id: restored.id, points: "0", program: { isArchived: false } });
  expect(data.history).toHaveLength(15);
  const audits = await h.db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.ownerId, f.ownerId), eq(auditLogs.action, "loyalty.program.restore")));
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ entityId: aa.programId, changes: {} });
});
