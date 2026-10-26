import { and, eq } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import * as s from "@/db/schema";
import { createEntry, getEntry } from "@/lib/ledger/entries";
import { stampAutoEntry, untouched } from "./auto-state";
import { clearingInput } from "./transfer-legs";
import { money } from "@/lib/money";
import type { ResetData } from "./reset-plan";

export async function resetReferences(db: AppDb, ownerId: string, data: ResetData) {
  const touches = (id: string | null | undefined) => Boolean(id && data.entryIds.has(id));
  const rowTouches = (id: string | null | undefined) => Boolean(id && data.rowIds.has(id));
  const statementIds = new Set(data.containers.map((row) => row.id));
  const [approvals, rewards, observations] = await Promise.all([
    db.select().from(s.importApprovals).where(eq(s.importApprovals.ownerId, ownerId)),
    db.select().from(s.loyaltyEvents).where(eq(s.loyaltyEvents.ownerId, ownerId)),
    db.select().from(s.loyaltyObservations).where(eq(s.loyaltyObservations.ownerId, ownerId)),
  ]);
  return {
    importRows: data.rows.filter(
      (row) =>
        !data.rowIds.has(row.id) &&
        (touches(row.journalEntryId) ||
          touches(row.linkedEntryId) ||
          row.duplicateCandidateEntryIds.some(touches) ||
          row.duplicateCandidateRowIds.some(rowTouches) ||
          row.pairing.some((pair) => touches(pair.entryId) || rowTouches(pair.rowId)) ||
          touches(row.decisionPayload.linkEntryId) ||
          touches(row.decisionPayload.pairEntryId) ||
          rowTouches(row.decisionPayload.pairRowId)),
    ),
    approvals: approvals.filter(
      (row) =>
        statementIds.has(row.statementId) ||
        row.result.some((item) => touches(item.entryId) || rowTouches(item.rowId)),
    ),
    rewards: rewards.filter(
      (row) => touches(row.relatedJournalEntryId) || (row.statementId && statementIds.has(row.statementId)),
    ),
    observations: observations.filter((row) => row.statementId && statementIds.has(row.statementId)),
  };
}
type ResetReferences = Awaited<ReturnType<typeof resetReferences>>;
export async function clearResetReferences(
  db: AppDb,
  ownerId: string,
  data: ResetData,
  references: ResetReferences,
) {
  const touches = (id: string | null | undefined) => Boolean(id && data.entryIds.has(id));
  const rowTouches = (id: string | null | undefined) => Boolean(id && data.rowIds.has(id));
  const statementIds = new Set(data.containers.map((row) => row.id));
  for (const peer of data.survivingPeers) {
    const canRestamp = untouched(await getEntry(db, ownerId, peer.id));
    await db
      .update(s.journalEntries)
      .set({ transferMatchId: null, entryType: "transfer" })
      .where(and(eq(s.journalEntries.ownerId, ownerId), eq(s.journalEntries.id, peer.id)));
    if (canRestamp) await stampAutoEntry(db, ownerId, peer.id);
  }
  for (const entry of [...data.survivingRefunds, ...data.survivingReplacements]) {
    const canRestamp = untouched(await getEntry(db, ownerId, entry.id));
    await db
      .update(s.journalEntries)
      .set({
        ...(touches(entry.refundOfEntryId) ? { refundOfEntryId: null } : {}),
        ...(touches(entry.replacesEntryId) ? { replacesEntryId: null } : {}),
      })
      .where(and(eq(s.journalEntries.ownerId, ownerId), eq(s.journalEntries.id, entry.id)));
    if (canRestamp) await stampAutoEntry(db, ownerId, entry.id);
  }
  const legacyReplacements = new Map<string, string>();
  for (const row of references.importRows) {
    let replacementId: string | null = null;
    if (data.preserveLegacyRows.some((item) => item.id === row.id)) {
      const old = await getEntry(db, ownerId, data.preserveLegacyEntries.get(row.id)!);
      const key = `${old.id}:${row.accountId}`;
      replacementId = legacyReplacements.get(key) ?? null;
      if (!replacementId) {
        const input = await clearingInput(db, ownerId, {
          ...row,
          amount: old.postings
            .filter((line) => line.accountId === row.accountId)
            .reduce((sum, line) => sum.plus(money(line.amount)), money("0"))
            .toFixed(4),
          transactionDate: old.eventDate,
          postedDate: old.postedDate,
          merchantNormalized: old.merchant ?? row.merchantNormalized,
          descriptionRaw: old.description ?? row.descriptionRaw,
        });
        // Provider uniqueness is released below when the old entry is removed.
        const entry = await createEntry(db, ownerId, {
          ...input,
          source: old.source,
          externalReference: old.externalReference,
          notes: old.notes,
        });
        await stampAutoEntry(db, ownerId, entry.id, !untouched(old));
        replacementId = entry.id;
        legacyReplacements.set(key, entry.id);
      }
    }
    const hadEntry = touches(row.journalEntryId) || touches(row.linkedEntryId);
    const { linkEntryId, pairEntryId, pairRowId, ...otherPayload } = row.decisionPayload;
    await db
      .update(s.importRows)
      .set({
        ...(hadEntry
          ? {
              journalEntryId: null,
              linkedEntryId: replacementId,
              decision: replacementId ? "link_existing" : "pending",
              autoPostState: replacementId ? "posted" : "none",
              reviewedAt: replacementId ? row.reviewedAt : null,
            }
          : {}),
        duplicateCandidateEntryIds: row.duplicateCandidateEntryIds.filter((id) => !touches(id)),
        duplicateCandidateRowIds: row.duplicateCandidateRowIds.filter((id) => !rowTouches(id)),
        pairing: row.pairing.filter((pair) => !touches(pair.entryId) && !rowTouches(pair.rowId)),
        decisionPayload: {
          ...otherPayload,
          ...(!touches(linkEntryId) && linkEntryId ? { linkEntryId } : {}),
          ...(!touches(pairEntryId) && pairEntryId ? { pairEntryId } : {}),
          ...(!rowTouches(pairRowId) && pairRowId ? { pairRowId } : {}),
        },
      })
      .where(and(eq(s.importRows.ownerId, ownerId), eq(s.importRows.id, row.id)));
    if (replacementId) {
      const [claimed] = await db
        .select({ id: s.importRows.id })
        .from(s.importRows)
        .where(and(eq(s.importRows.ownerId, ownerId), eq(s.importRows.journalEntryId, replacementId)));
      if (!claimed)
        await db
          .update(s.importRows)
          .set({ journalEntryId: replacementId, linkedEntryId: null })
          .where(and(eq(s.importRows.ownerId, ownerId), eq(s.importRows.id, row.id)));
    }
  }
  // Approval results are cached links. Drop affected caches, not their surviving statements/rows.
  for (const row of references.approvals)
    await db
      .delete(s.importApprovals)
      .where(and(eq(s.importApprovals.ownerId, ownerId), eq(s.importApprovals.id, row.id)));
  for (const row of references.rewards)
    await db
      .update(s.loyaltyEvents)
      .set({
        ...(touches(row.relatedJournalEntryId) ? { relatedJournalEntryId: null } : {}),
        ...(row.statementId && statementIds.has(row.statementId) ? { statementId: null } : {}),
      })
      .where(and(eq(s.loyaltyEvents.ownerId, ownerId), eq(s.loyaltyEvents.id, row.id)));
  for (const row of references.observations)
    await db
      .update(s.loyaltyObservations)
      .set({ statementId: null })
      .where(and(eq(s.loyaltyObservations.ownerId, ownerId), eq(s.loyaltyObservations.id, row.id)));
}
