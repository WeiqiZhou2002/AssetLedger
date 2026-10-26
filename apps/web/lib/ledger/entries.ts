import { loadMatchedTransfers } from "./transfers";
import { unlinkLeg } from "@/lib/bank-sync/transfer-legs";
import { and, eq, inArray, or, ne } from "drizzle-orm";
import { auditLogs, categories, journalEntries, postings, importRows } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { entrySchema, metaSchema, type EntryInput, type ValidEntry } from "./schemas";
import { validateEntry } from "./validation";
import { loadPostingAccounts } from "./accounts";
import { validateGroupLink, validateRefundLink } from "./group-links";
import { auditLedger } from "./audit";
import { invariant } from "./errors";
import { requireCategory } from "./categories";
export async function entryLines(db: AppDb, ownerId: string, id: string) {
  return db
    .select()
    .from(postings)
    .where(and(eq(postings.ownerId, ownerId), eq(postings.journalEntryId, id)))
    .orderBy(postings.createdAt, postings.id);
}
export async function getEntry(db: AppDb, ownerId: string, id: string) {
  const [entry] = await db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, id)));
  invariant(entry, "流水不存在", 404);
  const [lines, history, upstream, transfers] = await Promise.all([
    entryLines(db, ownerId, id),
    db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.ownerId, ownerId),
          eq(auditLogs.entityType, "journal_entry"),
          eq(auditLogs.entityId, id),
        ),
      )
      .orderBy(auditLogs.createdAt),
    db
      .select({ rowId: importRows.id, statementId: importRows.statementId, state: importRows.upstreamState })
      .from(importRows)
      .where(
        and(
          eq(importRows.ownerId, ownerId),
          or(eq(importRows.journalEntryId, id), eq(importRows.linkedEntryId, id)),
          ne(importRows.upstreamState, "none"),
        ),
      ),
    loadMatchedTransfers(
      db,
      ownerId,
      entry.status === "confirmed" && entry.transferMatchId ? [entry.transferMatchId] : [],
    ),
  ]);
  return {
    ...entry,
    postings: lines,
    audit: history,
    upstream,
    transfer: entry.transferMatchId ? (transfers.get(entry.transferMatchId) ?? null) : null,
  };
}
async function validateWithDb(db: AppDb, ownerId: string, values: ValidEntry) {
  const accountRows = await loadPostingAccounts(
    db,
    ownerId,
    values.postings.map((line) => line.accountId),
  );
  const ids = values.postings.flatMap((line) => (line.categoryId ? [line.categoryId] : []));
  const categoryRows = ids.length
    ? await db
        .select()
        .from(categories)
        .where(and(eq(categories.ownerId, ownerId), inArray(categories.id, ids)))
        .orderBy(categories.id)
        .for("share")
    : [];
  validateEntry(values, ownerId, accountRows, categoryRows);
  if (values.purchaseGroupId) {
    await validateGroupLink(db, ownerId, values.purchaseGroupId, values);
  }
  await validateRefundLink(db, ownerId, values);
}
async function insertEntry(db: AppDb, ownerId: string, values: ValidEntry, replacesEntryId?: string) {
  await validateWithDb(db, ownerId, values);
  const { postings: lines, ...entry } = values;
  const [created] = await db
    .insert(journalEntries)
    .values({ ...entry, ownerId, replacesEntryId })
    .returning();
  await db.insert(postings).values(
    lines.map((line) => ({
      ...line,
      amount: line.amount,
      categoryId: line.categoryId ?? null,
      ownerId,
      journalEntryId: created.id,
    })),
  );
  await auditLedger(db, ownerId, "journal_entry", created.id, "entry.create", {
    status: values.status,
    replacesEntryId,
  });
  return { ...created, postings: await entryLines(db, ownerId, created.id) };
}
export async function createEntry(db: AppDb, ownerId: string, input: EntryInput) {
  const values = entrySchema.parse(input);
  return db.transaction((tx) => insertEntry(tx, ownerId, values));
}
async function lockedEntry(db: AppDb, ownerId: string, id: string) {
  const [entry] = await db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, id)))
    .for("update");
  invariant(entry, "流水不存在", 404);
  return entry;
}
export async function confirmEntry(db: AppDb, ownerId: string, id: string) {
  return db.transaction(async (tx) => {
    const entry = await lockedEntry(tx, ownerId, id);
    invariant(entry.status === "draft", "只能确认草稿", 409);
    const lines = await entryLines(tx, ownerId, id);
    await validateWithDb(
      tx,
      ownerId,
      entrySchema.parse({
        entryType: entry.entryType,
        benefitCredit: entry.benefitCredit,
        benefitFamily: entry.benefitFamily,
        status: "confirmed",
        eventDate: entry.eventDate,
        postedDate: entry.postedDate,
        notes: entry.notes,
        purchaseGroupId: entry.purchaseGroupId,
        refundOfEntryId: entry.refundOfEntryId,
        postings: lines.map(({ accountId, categoryId, amount, currency, memo }) => ({
          accountId,
          categoryId,
          amount,
          currency,
          memo,
        })),
      }),
    );
    const [result] = await tx
      .update(journalEntries)
      .set({ status: "confirmed" })
      .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, id)))
      .returning();
    await auditLedger(tx, ownerId, "journal_entry", id, "entry.confirm");
    return result;
  });
}
export async function voidEntry(db: AppDb, ownerId: string, id: string, reason: string) {
  invariant(
    typeof reason === "string" && reason.trim().length > 0 && reason.length <= 2000,
    "请填写作废原因",
  );
  return db.transaction(async (tx) => {
    const entry = await lockedEntry(tx, ownerId, id);
    invariant(entry.status !== "voided", "流水已作废", 409);
    if (entry.transferMatchId) await unlinkLeg(tx, ownerId, id, true, true);
    const [result] = await tx
      .update(journalEntries)
      .set({ status: "voided", voidedAt: new Date(), voidReason: reason.trim() })
      .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, id)))
      .returning();
    await auditLedger(tx, ownerId, "journal_entry", id, "entry.void", { reason });
    return result;
  });
}
export async function replaceEntry(
  db: AppDb,
  ownerId: string,
  id: string,
  input: EntryInput,
  reason: string,
) {
  const values = entrySchema.parse(input);
  return db.transaction(async (tx) => {
    const original = await lockedEntry(tx, ownerId, id);
    invariant(original.status !== "voided", "不能替换已作废流水", 409);
    await voidEntry(tx, ownerId, id, reason);
    const replacement = await insertEntry(tx, ownerId, values, id);
    await auditLedger(tx, ownerId, "journal_entry", id, "entry.replace", { replacementId: replacement.id });
    return replacement;
  });
}
export async function updateEntryMeta(db: AppDb, ownerId: string, id: string, input: unknown) {
  const { categories: changes, ...values } = metaSchema.parse(input);
  return db.transaction(async (tx) => {
    const entry = await lockedEntry(tx, ownerId, id);
    invariant(entry.status !== "voided", "已作废流水不能编辑", 409);
    const lines = await entryLines(tx, ownerId, id);
    const accountRows = await loadPostingAccounts(
      tx,
      ownerId,
      lines.map((line) => line.accountId),
    );
    // Category metadata may change on income/expense lines; amounts and dates never enter an update.
    // Archived historical categories remain valid when unchanged.
    for (const change of changes ?? []) {
      const line = lines.find((row) => row.id === change.postingId);
      const kind = line && accountRows.find((account) => account.id === line.accountId)?.type;
      invariant(line && (kind === "expense" || kind === "income"), "只能修改本流水的收支分类");
      if (line.categoryId !== change.categoryId) {
        await requireCategory(tx, ownerId, change.categoryId, kind);
      }
    }
    invariant(
      entry.entryType !== "balance_adjustment" ||
        (values.notes === undefined ? entry.notes : values.notes)?.trim(),
      "余额调整必须保留原因",
    );
    await tx
      .update(journalEntries)
      .set({ ...values, updatedAt: new Date(), ...(entry.autoPosted ? { autoPostOwnerEdited: true } : {}) })
      .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, id)));
    for (const change of changes ?? []) {
      await tx
        .update(postings)
        .set({ categoryId: change.categoryId })
        .where(
          and(
            eq(postings.ownerId, ownerId),
            eq(postings.journalEntryId, id),
            eq(postings.id, change.postingId),
          ),
        );
    }
    await auditLedger(tx, ownerId, "journal_entry", id, "entry.meta", { ...values, categories: changes });
    return getEntry(tx, ownerId, id);
  });
}
