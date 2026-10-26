import { and, eq, sql } from "drizzle-orm";
import { accounts, journalEntries, postings, purchaseGroups } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { money } from "@/lib/money";
import { groupPatchSchema, groupSchema } from "./schemas";
import { requireCategory } from "./categories";
import { entryLines } from "./entries";
import { invariant } from "./errors";
import { validateGroupLink } from "./group-links";
import { auditLedger } from "./audit";
export async function createPurchaseGroup(db: AppDb, ownerId: string, input: unknown) {
  const values = groupSchema.parse(input);
  return db.transaction(async (tx) => {
    if (values.categoryId) await requireCategory(tx, ownerId, values.categoryId, "expense");
    const [row] = await tx
      .insert(purchaseGroups)
      .values({ ...values, ownerId })
      .returning();
    await auditLedger(tx, ownerId, "purchase_group", row.id, "group.create", values);
    return row;
  });
}
export async function updatePurchaseGroup(db: AppDb, ownerId: string, id: string, input: unknown) {
  const values = groupPatchSchema.parse(input);
  return db.transaction(async (tx) => {
    const [group] = await tx
      .select()
      .from(purchaseGroups)
      .where(and(eq(purchaseGroups.ownerId, ownerId), eq(purchaseGroups.id, id)))
      .for("update");
    invariant(group, "购物组不存在", 404);
    if (values.categoryId) await requireCategory(tx, ownerId, values.categoryId, "expense");
    if (values.currency && values.currency !== group.currency) {
      const linked = await tx
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.purchaseGroupId, id)))
        .limit(1);
      invariant(!linked.length, "已关联流水的购物组不能更改币种");
    }
    const [row] = await tx
      .update(purchaseGroups)
      .set(values)
      .where(and(eq(purchaseGroups.ownerId, ownerId), eq(purchaseGroups.id, id)))
      .returning();
    await auditLedger(tx, ownerId, "purchase_group", id, "group.update", values);
    return row;
  });
}
export async function linkGroupEntry(
  db: AppDb,
  ownerId: string,
  groupId: string,
  entryId: string,
  unlink = false,
) {
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, entryId)))
      .for("update");
    invariant(entry, "流水不存在", 404);
    invariant(entry.status !== "voided", "已作废流水不能修改关联", 409);
    if (unlink) {
      invariant(entry.purchaseGroupId === groupId, "流水未关联此购物组", 404);
    } else {
      invariant(!entry.purchaseGroupId || entry.purchaseGroupId === groupId, "请先从原购物组移除流水", 409);
      await validateGroupLink(tx, ownerId, groupId, {
        entryType: entry.entryType,
        postings: await entryLines(tx, ownerId, entryId),
      });
    }
    await tx
      .update(journalEntries)
      .set({ purchaseGroupId: unlink ? null : groupId })
      .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, entryId)));
    await auditLedger(tx, ownerId, "journal_entry", entryId, unlink ? "group.unlink" : "group.link", {
      groupId,
    });
    await auditLedger(tx, ownerId, "purchase_group", groupId, unlink ? "group.unlink" : "group.link", {
      entryId,
    });
  });
}
export async function listPurchaseGroups(db: AppDb, ownerId: string) {
  const [groups, sums] = await Promise.all([
    db
      .select()
      .from(purchaseGroups)
      .where(eq(purchaseGroups.ownerId, ownerId))
      .orderBy(purchaseGroups.createdAt),
    db
      .select({ groupId: journalEntries.purchaseGroupId, total: sql<string>`sum(${postings.amount})::text` })
      .from(postings)
      .innerJoin(
        journalEntries,
        and(eq(journalEntries.id, postings.journalEntryId), eq(journalEntries.ownerId, ownerId)),
      )
      .innerJoin(accounts, and(eq(accounts.id, postings.accountId), eq(accounts.ownerId, ownerId)))
      .where(
        and(
          eq(postings.ownerId, ownerId),
          eq(accounts.type, "expense"),
          eq(journalEntries.status, "confirmed"),
        ),
      )
      .groupBy(journalEntries.purchaseGroupId),
  ]);
  const amounts = new Map(sums.map((row) => [row.groupId, row.total]));
  return groups.map((group) => {
    const actual = amounts.get(group.id) ?? "0";
    const difference =
      group.confirmedTotal === null ? null : money(group.confirmedTotal).minus(actual).toFixed(4);
    return {
      ...group,
      actual,
      difference,
      status: difference !== null && money(difference).isZero() ? ("reconciled" as const) : ("open" as const),
    };
  });
}
