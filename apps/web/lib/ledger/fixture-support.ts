import { and, eq } from "drizzle-orm";
import { balanceSnapshots, journalEntries } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { auditLedger } from "@/lib/ledger/audit";
import type { SnapshotInput } from "@/lib/snapshots/schemas";
import { createSnapshot, publishSnapshot } from "@/lib/snapshots/service";
export async function fixtureEntry(db: AppDb, ownerId: string, reference: string) {
  const [row] = await db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.externalReference, reference)));
  return row;
}
export async function tagFixtureEntry(db: AppDb, ownerId: string, id: string, reference: string) {
  await db
    .update(journalEntries)
    .set({ externalReference: reference })
    .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, id)));
  await auditLedger(db, ownerId, "journal_entry", id, "entry.fixture_reference");
}
export async function fixtureSnapshot(db: AppDb, ownerId: string, label: string) {
  const [row] = await db
    .select()
    .from(balanceSnapshots)
    .where(and(eq(balanceSnapshots.ownerId, ownerId), eq(balanceSnapshots.label, label)));
  return row;
}

export async function publishFixtureObservation(db: AppDb, ownerId: string, input: SnapshotInput) {
  const observation = await createSnapshot(db, ownerId, input);
  await db
    .update(balanceSnapshots)
    .set({ source: "plaid" })
    .where(and(eq(balanceSnapshots.ownerId, ownerId), eq(balanceSnapshots.id, observation.id)));
  return publishSnapshot(db, ownerId, observation.id);
}
