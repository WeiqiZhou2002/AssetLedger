import { and, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  loyaltyAccounts,
  loyaltyEvents,
  loyaltyObservations,
  loyaltyTransfers,
} from "@/db/schema";
import type { AppDb } from "@/db/types";
import { invariant } from "@/lib/ledger/errors";
import { requireLoyaltyAccount, rewardsLock } from "./store";

const count = z.number().int().nonnegative();
const countsSchema = z
  .object({
    events: count,
    observations: count,
    transfers: count,
    otherAccountEvents: count,
  })
  .strict();
export type LoyaltyAccountDeleteCounts = z.infer<typeof countsSchema>;

async function deletionPlan(db: AppDb, ownerId: string, id: string) {
  await requireLoyaltyAccount(db, ownerId, id);
  const events = await db
    .select({ id: loyaltyEvents.id })
    .from(loyaltyEvents)
    .where(and(eq(loyaltyEvents.ownerId, ownerId), eq(loyaltyEvents.loyaltyAccountId, id)));
  const ownIds = events.map((row) => row.id);
  const transfers = ownIds.length
    ? await db
        .select({
          id: loyaltyTransfers.id,
          fromEventId: loyaltyTransfers.fromEventId,
          toEventId: loyaltyTransfers.toEventId,
        })
        .from(loyaltyTransfers)
        .where(
          and(
            eq(loyaltyTransfers.ownerId, ownerId),
            or(inArray(loyaltyTransfers.fromEventId, ownIds), inArray(loyaltyTransfers.toEventId, ownIds)),
          ),
        )
    : [];
  const eventIds = [...new Set([...ownIds, ...transfers.flatMap((row) => [row.fromEventId, row.toEventId])])];
  const observations = await db
    .select({ id: loyaltyObservations.id })
    .from(loyaltyObservations)
    .where(and(eq(loyaltyObservations.ownerId, ownerId), eq(loyaltyObservations.loyaltyAccountId, id)));
  return {
    eventIds,
    transferIds: transfers.map((row) => row.id),
    counts: {
      events: eventIds.length,
      observations: observations.length,
      transfers: transfers.length,
      otherAccountEvents: eventIds.length - ownIds.length,
    },
  };
}
export async function previewLoyaltyAccountDelete(db: AppDb, ownerId: string, id: string) {
  return db.transaction(async (tx) => {
    await rewardsLock(tx, ownerId);
    return (await deletionPlan(tx, ownerId, id)).counts;
  });
}
export async function deleteLoyaltyAccount(db: AppDb, ownerId: string, id: string, input: unknown) {
  const expected = countsSchema.parse(input);
  return db.transaction(async (tx) => {
    await rewardsLock(tx, ownerId);
    const plan = await deletionPlan(tx, ownerId, id);
    invariant(
      Object.entries(expected).every(
        ([key, value]) => plan.counts[key as keyof LoyaltyAccountDeleteCounts] === value,
      ),
      "关联记录已变化，请重新预览后删除",
      409,
    );
    if (plan.transferIds.length)
      await tx
        .delete(loyaltyTransfers)
        .where(and(eq(loyaltyTransfers.ownerId, ownerId), inArray(loyaltyTransfers.id, plan.transferIds)));
    if (plan.eventIds.length)
      await tx
        .delete(loyaltyEvents)
        .where(and(eq(loyaltyEvents.ownerId, ownerId), inArray(loyaltyEvents.id, plan.eventIds)));
    await tx
      .delete(loyaltyObservations)
      .where(and(eq(loyaltyObservations.ownerId, ownerId), eq(loyaltyObservations.loyaltyAccountId, id)));
    await tx
      .delete(loyaltyAccounts)
      .where(and(eq(loyaltyAccounts.ownerId, ownerId), eq(loyaltyAccounts.id, id)));
    // Deliberate count-only payload; never widen the general audit redactor.
    await tx.insert(auditLogs).values({
      ownerId,
      actorUserId: ownerId,
      entityType: "loyalty_account",
      entityId: id,
      action: "loyalty.account.delete",
      changes: plan.counts,
    });
    return plan.counts;
  });
}
