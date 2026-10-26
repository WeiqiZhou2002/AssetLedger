import { and, eq, inArray, or } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import {
  transferPairConfirmations as confirmations,
  transferPairRejections as rejections,
  transferAccountAssignments as assignments,
} from "@/db/schema";
import { orderedPairKeys, transferPairKey } from "./transfer-pair-keys";

// Callers hold the owner import lock. Stable keys are storage-only; audits use entry/account IDs.
export async function forgetTransferChoices(db: AppDb, ownerId: string, keys: string[]) {
  if (!keys.length) return;
  await db
    .delete(confirmations)
    .where(
      and(
        eq(confirmations.ownerId, ownerId),
        or(inArray(confirmations.leftKey, keys), inArray(confirmations.rightKey, keys)),
      ),
    );
  await db
    .delete(assignments)
    .where(and(eq(assignments.ownerId, ownerId), inArray(assignments.legKey, keys)));
}
export async function rememberTransferPair(db: AppDb, ownerId: string, a: string, b: string) {
  const pair = orderedPairKeys(a, b);
  await forgetTransferChoices(db, ownerId, [a, b]);
  await db
    .delete(rejections)
    .where(
      and(
        eq(rejections.ownerId, ownerId),
        eq(rejections.leftKey, pair.leftKey),
        eq(rejections.rightKey, pair.rightKey),
      ),
    );
  await db.insert(confirmations).values({ ownerId, ...pair });
}
export async function rememberTransferRejection(db: AppDb, ownerId: string, a: string, b: string) {
  const pair = orderedPairKeys(a, b);
  await db
    .delete(confirmations)
    .where(
      and(
        eq(confirmations.ownerId, ownerId),
        eq(confirmations.leftKey, pair.leftKey),
        eq(confirmations.rightKey, pair.rightKey),
      ),
    );
  await db
    .insert(rejections)
    .values({ ownerId, ...pair })
    .onConflictDoUpdate({
      target: [rejections.ownerId, rejections.leftKey, rejections.rightKey],
      set: { updatedAt: new Date() },
    });
}
export async function rememberTransferAssignment(
  db: AppDb,
  ownerId: string,
  legKey: string,
  accountId: string,
) {
  await forgetTransferChoices(db, ownerId, [legKey]);
  await db.insert(assignments).values({ ownerId, legKey, accountId });
}
export const assignmentReference = (legKey: string) => `transfer:assigned:${transferPairKey(legKey, legKey)}`;
