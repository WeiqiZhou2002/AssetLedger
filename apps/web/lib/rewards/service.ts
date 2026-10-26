import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  loyaltyPrograms,
  loyaltyAccounts,
  loyaltyCppHistory,
  loyaltyEvents,
  loyaltyObservations,
  loyaltyTransfers,
} from "@/db/schema";
import type { AppDb } from "@/db/types";
import { requireAccount } from "@/lib/ledger/accounts";
import { getEntry } from "@/lib/ledger/entries";
import { invariant } from "@/lib/ledger/errors";
import { auditLedger } from "@/lib/ledger/audit";
import { defaultPrograms } from "./constants";
import {
  accountSchema,
  cppHistorySchema,
  eventSchema,
  observationSchema,
  programSchema,
  transferSchema,
} from "./schemas";
import { requireLoyaltyAccount, requireProgram, rewardsLock } from "./store";
export async function ensurePrograms(db: AppDb, ownerId: string) {
  return db.transaction(async (tx) => {
    await rewardsLock(tx, ownerId);
    for (const defaults of defaultPrograms) {
      const { baseline, personal, ...values } = defaults;
      const [program] = await tx
        .insert(loyaltyPrograms)
        .values({ ...values, ownerId })
        .onConflictDoNothing({ target: [loyaltyPrograms.ownerId, loyaltyPrograms.code] })
        .returning();
      if (!program) continue;
      await tx.insert(loyaltyCppHistory).values({
        ownerId,
        programId: program.id,
        effectiveDate: "1970-01-01",
        cppBaseline: baseline,
        cppPersonal: personal,
        source: "default",
      });
      await auditLedger(tx, ownerId, "loyalty_program", program.id, "loyalty.seed");
    }
  });
}
export async function listPrograms(db: AppDb, ownerId: string) {
  await ensurePrograms(db, ownerId);
  return db
    .select()
    .from(loyaltyPrograms)
    .where(eq(loyaltyPrograms.ownerId, ownerId))
    .orderBy(loyaltyPrograms.code);
}
export async function saveProgram(db: AppDb, ownerId: string, input: unknown, id?: string) {
  const values = (id ? programSchema.partial() : programSchema).parse(input);
  await ensurePrograms(db, ownerId);
  return db.transaction(async (tx) => {
    await rewardsLock(tx, ownerId);
    if (id) await requireProgram(tx, ownerId, id);
    // Codes are stable identities, particularly VS and ANA.
    if (id && values.code)
      invariant(values.code === (await requireProgram(tx, ownerId, id)).code, "项目代码不能更改");
    const [program] = id
      ? await tx
          .update(loyaltyPrograms)
          .set(values)
          .where(and(eq(loyaltyPrograms.ownerId, ownerId), eq(loyaltyPrograms.id, id)))
          .returning()
      : await tx
          .insert(loyaltyPrograms)
          .values({ ...programSchema.parse(input), ownerId })
          .returning();
    if (!id)
      await tx.insert(loyaltyCppHistory).values({
        ownerId,
        programId: program.id,
        effectiveDate: "1970-01-01",
        cppBaseline: "1",
        cppPersonal: "1",
        source: "default",
      });
    await auditLedger(
      tx,
      ownerId,
      "loyalty_program",
      program.id,
      id ? "loyalty.program.update" : "loyalty.program.create",
    );
    return program;
  });
}
export async function listLoyaltyAccounts(db: AppDb, ownerId: string) {
  return db
    .select()
    .from(loyaltyAccounts)
    .where(eq(loyaltyAccounts.ownerId, ownerId))
    .orderBy(loyaltyAccounts.name);
}
export async function saveLoyaltyAccount(db: AppDb, ownerId: string, input: unknown, id?: string) {
  const values = (id ? accountSchema.partial().omit({ programId: true }) : accountSchema).parse(input);
  return db.transaction(async (tx) => {
    await rewardsLock(tx, ownerId);
    if (id) await requireLoyaltyAccount(tx, ownerId, id);
    else {
      const program = await requireProgram(tx, ownerId, accountSchema.parse(input).programId);
      if (program.isArchived) {
        await tx
          .update(loyaltyPrograms)
          .set({ isArchived: false, updatedAt: new Date() })
          .where(and(eq(loyaltyPrograms.ownerId, ownerId), eq(loyaltyPrograms.id, program.id)));
        await auditLedger(tx, ownerId, "loyalty_program", program.id, "loyalty.program.restore");
      }
    }
    if (values.linkedCardAccountId) {
      const card = await requireAccount(tx, ownerId, values.linkedCardAccountId);
      invariant(card.type === "liability_credit_card" && card.isActive, "关联账户须为启用的信用卡");
    }
    const [account] = id
      ? await tx
          .update(loyaltyAccounts)
          .set(values)
          .where(and(eq(loyaltyAccounts.ownerId, ownerId), eq(loyaltyAccounts.id, id)))
          .returning()
      : await tx
          .insert(loyaltyAccounts)
          .values({ ...accountSchema.parse(input), ownerId })
          .returning();
    await auditLedger(
      tx,
      ownerId,
      "loyalty_account",
      account.id,
      id ? "loyalty.account.update" : "loyalty.account.create",
    );
    return account;
  });
}
export async function createEvent(db: AppDb, ownerId: string, input: unknown) {
  const values = eventSchema.parse(input);
  const delta = BigInt(values.pointsDelta);
  invariant(
    values.type === "adjust" || (["redeem", "expire"].includes(values.type) ? delta < 0n : delta > 0n),
    "兑换/过期须为负数，获得/奖励/退回/购买须为正数",
  );
  return db.transaction(async (tx) => {
    await rewardsLock(tx, ownerId);
    await requireLoyaltyAccount(tx, ownerId, values.loyaltyAccountId, true);
    if (values.relatedJournalEntryId) await getEntry(tx, ownerId, values.relatedJournalEntryId);
    const [event] = await tx
      .insert(loyaltyEvents)
      .values({ ...values, ownerId, pointsDelta: delta, source: "manual" })
      .returning();
    await auditLedger(tx, ownerId, "loyalty_event", event.id, "loyalty.event.create");
    return event;
  });
}
export async function createObservation(db: AppDb, ownerId: string, input: unknown) {
  const values = observationSchema.parse(input);
  return db.transaction(async (tx) => {
    await rewardsLock(tx, ownerId);
    await requireLoyaltyAccount(tx, ownerId, values.loyaltyAccountId, true);
    const [observation] = await tx
      .insert(loyaltyObservations)
      .values({ ...values, ownerId, balance: BigInt(values.balance), source: "manual" })
      .returning();
    await auditLedger(tx, ownerId, "loyalty_observation", observation.id, "loyalty.observation.create");
    return observation;
  });
}
export async function transferPoints(db: AppDb, ownerId: string, input: unknown) {
  const values = transferSchema.parse(input);
  invariant(values.fromAccountId !== values.toAccountId, "转出与转入账户不能相同");
  return db.transaction(async (tx) => {
    await rewardsLock(tx, ownerId);
    await requireLoyaltyAccount(tx, ownerId, values.fromAccountId, true);
    await requireLoyaltyAccount(tx, ownerId, values.toAccountId, true);
    const id = randomUUID();
    const [from, to] = await tx
      .insert(loyaltyEvents)
      .values([
        {
          ownerId,
          loyaltyAccountId: values.fromAccountId,
          eventDate: values.eventDate,
          pointsDelta: -BigInt(values.fromPoints),
          type: "transfer_out",
          transferId: id,
          note: values.note,
        },
        {
          ownerId,
          loyaltyAccountId: values.toAccountId,
          eventDate: values.eventDate,
          pointsDelta: BigInt(values.toPoints),
          type: "transfer_in",
          transferId: id,
          note: values.note,
        },
      ])
      .returning();
    const [transfer] = await tx
      .insert(loyaltyTransfers)
      .values({
        id,
        ownerId,
        fromEventId: from.id,
        toEventId: to.id,
        ratioFrom: BigInt(values.fromPoints),
        ratioTo: BigInt(values.toPoints),
        note: values.note,
      })
      .returning();
    await auditLedger(tx, ownerId, "loyalty_transfer", id, "loyalty.transfer.create");
    return { transfer, from, to };
  });
}
export async function setCpp(db: AppDb, ownerId: string, input: unknown) {
  const values = cppHistorySchema.parse(input);
  return db.transaction(async (tx) => {
    await rewardsLock(tx, ownerId);
    await requireProgram(tx, ownerId, values.programId);
    const [cpp] = await tx
      .insert(loyaltyCppHistory)
      .values({ ...values, ownerId, source: "user" })
      .onConflictDoUpdate({
        target: [loyaltyCppHistory.ownerId, loyaltyCppHistory.programId, loyaltyCppHistory.effectiveDate],
        set: {
          cppBaseline: values.cppBaseline,
          cppPersonal: values.cppPersonal,
          note: values.note,
          source: "user",
          updatedAt: new Date(),
        },
      })
      .returning();
    await auditLedger(tx, ownerId, "loyalty_cpp", cpp.id, "loyalty.cpp.set");
    return cpp;
  });
}
