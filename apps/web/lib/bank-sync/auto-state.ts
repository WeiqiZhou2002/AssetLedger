import { and, eq } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import { importRows, journalEntries } from "@/db/schema";
import { getEntry } from "@/lib/ledger/entries";
import { sha256 } from "@/lib/imports/text";

export type ImportRow = typeof importRows.$inferSelect;
type EntryDetail = Awaited<ReturnType<typeof getEntry>>;
export function fingerprint(entry: EntryDetail) {
  return sha256(
    JSON.stringify({
      // Omit the default fields to preserve fingerprints stored before benefits were introduced.
      ...(entry.benefitCredit ? { benefitCredit: true, benefitFamily: entry.benefitFamily } : {}),
      entryType: entry.entryType,
      status: entry.status,
      eventDate: entry.eventDate,
      postedDate: entry.postedDate,
      merchant: entry.merchant,
      description: entry.description,
      notes: entry.notes,
      purchaseGroupId: entry.purchaseGroupId,
      refundOfEntryId: entry.refundOfEntryId,
      isSummary: entry.isSummary,
      transferMatchId: entry.transferMatchId,
      postings: entry.postings
        .map(({ accountId, amount, currency, categoryId, memo }) => ({
          accountId,
          amount,
          currency,
          categoryId,
          memo,
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    }),
  );
}
export function untouched(entry: EntryDetail) {
  return (
    entry.autoPosted &&
    entry.status === "confirmed" &&
    !entry.autoPostOwnerEdited &&
    entry.autoPostFingerprint === fingerprint(entry)
  );
}
export async function stampAutoEntry(db: AppDb, ownerId: string, id: string, ownerEdited = false) {
  const entry = await getEntry(db, ownerId, id);
  await db
    .update(journalEntries)
    .set({
      autoPosted: true,
      autoPostFingerprint: fingerprint(entry),
      autoPostOwnerEdited: ownerEdited || entry.autoPostOwnerEdited,
    })
    .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, id)));
}
export async function updateAutoRow(
  db: AppDb,
  ownerId: string,
  id: string,
  values: Partial<typeof importRows.$inferInsert>,
) {
  await db
    .update(importRows)
    .set(values)
    .where(and(eq(importRows.ownerId, ownerId), eq(importRows.id, id)));
}
