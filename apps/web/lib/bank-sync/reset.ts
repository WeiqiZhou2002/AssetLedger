import { rm } from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import * as s from "@/db/schema";
import { importLock } from "@/lib/imports/store";
import { lockOwnerStructure } from "@/lib/snapshots/groups";
import { rewardsLock } from "@/lib/rewards/store";
import { collectReset } from "./reset-plan";
import { resetReferences, clearResetReferences } from "./reset-references";
import { rememberResetCategories } from "./reset-memory";
import { writeResetRecovery } from "./reset-files";
import { syncCounts } from "./run-counts";
import type { ResetConfig } from "./reset-types";

export async function planReset(
  db: AppDb,
  ownerId: string,
  config: ResetConfig,
  input: unknown,
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    return (await collectReset(tx, ownerId, config, input, now)).preview;
  });
}
export async function executeReset(
  db: AppDb,
  ownerId: string,
  config: ResetConfig,
  input: unknown,
  now = new Date(),
) {
  let recoveryPath: string | undefined;
  try {
    return await db.transaction(async (tx) => {
      await importLock(tx, ownerId);
      await lockOwnerStructure(tx, ownerId);
      await rewardsLock(tx, ownerId);
      // Metadata edits also take entry locks. Keep the export and deletion on the same versions.
      await tx
        .select({ id: s.journalEntries.id })
        .from(s.journalEntries)
        .where(eq(s.journalEntries.ownerId, ownerId))
        .orderBy(s.journalEntries.id)
        .for("update");
      const data = await collectReset(tx, ownerId, config, input, now);
      const references = await resetReferences(tx, ownerId, data);
      const recovery = await writeResetRecovery(
        config,
        ownerId,
        {
          formatVersion: 1,
          purpose: "plaid-data-reset",
          ownerId,
          exportedAt: now.toISOString(),
          preview: data.preview,
          entries: data.removedEntries,
          postings: data.deletedLines,
          importRows: data.removedRows,
          openings: data.removedOpenings,
          statements: data.containers,
          linksBefore: {
            entries: [
              ...new Map(
                [...data.survivingPeers, ...data.survivingRefunds, ...data.survivingReplacements].map(
                  (row) => [row.id, row],
                ),
              ).values(),
            ],
            ...references,
          },
          snapshotItems: data.selection.deleteObservations ? data.observed : [],
          snapshotsBefore: data.selection.deleteObservations ? data.observationSnapshots : [],
          jobs: data.affectedJobs,
        },
        now,
      );
      recoveryPath = recovery.path;
      await rememberResetCategories(tx, ownerId, data);
      await clearResetReferences(tx, ownerId, data, references);
      const entries = [...data.entryIds];
      if (data.rowIds.size)
        await tx
          .delete(s.importRows)
          .where(and(eq(s.importRows.ownerId, ownerId), inArray(s.importRows.id, [...data.rowIds])));
      if (entries.length) {
        await tx
          .delete(s.postings)
          .where(and(eq(s.postings.ownerId, ownerId), inArray(s.postings.journalEntryId, entries)));
        await tx
          .delete(s.journalEntries)
          .where(and(eq(s.journalEntries.ownerId, ownerId), inArray(s.journalEntries.id, entries)));
      }
      if (data.selection.deleteObservations && data.observed.length) {
        await tx.delete(s.snapshotItems).where(
          and(
            eq(s.snapshotItems.ownerId, ownerId),
            inArray(
              s.snapshotItems.id,
              data.observed.map((row) => row.id),
            ),
          ),
        );
        // Invalidate editors' revisions; frozen historical reconciliation results are retained.
        for (const id of new Set(data.observed.map((row) => row.snapshotId))) {
          const [snapshot] = await tx
            .select()
            .from(s.balanceSnapshots)
            .where(and(eq(s.balanceSnapshots.ownerId, ownerId), eq(s.balanceSnapshots.id, id)));
          await tx
            .update(s.balanceSnapshots)
            .set({ revision: snapshot.revision + 1 })
            .where(and(eq(s.balanceSnapshots.ownerId, ownerId), eq(s.balanceSnapshots.id, id)));
        }
      }
      if (data.containers.length) {
        const ids = data.containers.map((row) => row.id);
        await tx
          .delete(s.importJobs)
          .where(and(eq(s.importJobs.ownerId, ownerId), inArray(s.importJobs.statementId, ids)));
        await tx
          .delete(s.statements)
          .where(and(eq(s.statements.ownerId, ownerId), inArray(s.statements.id, ids)));
      }
      const jobs: { connectionId: string; jobId: string }[] = [];
      for (const connection of data.selection.connections) {
        await tx
          .update(s.importJobs)
          .set({ status: "failed", errorKind: "SYNC_GENERATION_SUPERSEDED", lockedAt: null, lockedBy: null })
          .where(
            and(
              eq(s.importJobs.ownerId, ownerId),
              eq(s.importJobs.connectionId, connection.id),
              inArray(s.importJobs.status, ["queued", "running"]),
            ),
          );
        await tx
          .update(s.bankSyncRuns)
          .set({ status: "superseded", finishedAt: now })
          .where(
            and(
              eq(s.bankSyncRuns.ownerId, ownerId),
              eq(s.bankSyncRuns.connectionId, connection.id),
              inArray(s.bankSyncRuns.status, ["queued", "running", "not_ready"]),
            ),
          );
        await tx
          .update(s.bankConnectionAccounts)
          .set({ importFromDate: null })
          .where(
            and(
              eq(s.bankConnectionAccounts.ownerId, ownerId),
              eq(s.bankConnectionAccounts.connectionId, connection.id),
            ),
          );
        const generation = connection.syncGeneration + 1;
        await tx
          .update(s.bankConnections)
          .set({
            transactionsCursor: null,
            syncGeneration: generation,
            importFromDate: data.selection.from,
            backfillPlan: null,
            matchingVersion: 0,
            matchingGeneration: -1,
            benefitVersion: 0,
            lastRequestedAt: now,
          })
          .where(and(eq(s.bankConnections.ownerId, ownerId), eq(s.bankConnections.id, connection.id)));
        let jobId: string | undefined;
        if (connection.mappingConfirmedAt) {
          const [job] = await tx
            .insert(s.importJobs)
            .values({
              ownerId,
              connectionId: connection.id,
              kind: "plaid_sync",
              syncGeneration: generation,
              runAfter: now,
            })
            .returning();
          jobs.push({ connectionId: connection.id, jobId: job.id });
          jobId = job.id;
        }
        await tx.insert(s.bankSyncRuns).values({
          ownerId,
          connectionId: connection.id,
          jobId,
          kind: "reset",
          status: "succeeded",
          startedAt: now,
          finishedAt: now,
          effectiveFromDate: data.selection.from,
          counts: {
            ...syncCounts(),
            ...data.preview.connections.find((row) => row.connectionId === connection.id)!.counts,
          },
        });
      }
      const expiresAt = new Date(now.getTime() + config.FILE_RETENTION_DAYS * 86400000);
      await tx.insert(s.bankResetExports).values({
        id: recovery.id,
        ownerId,
        storagePath: recovery.storagePath,
        expiresAt,
        counts: data.preview.totals,
        createdAt: now,
      });
      // Reset counts are a closed numeric allowlist; keep the general audit redactor unchanged.
      await tx.insert(s.auditLogs).values({
        ownerId,
        actorUserId: ownerId,
        entityType: "plaid_reset",
        entityId: recovery.id,
        action: "bank.reset",
        changes: data.preview.totals,
      });
      return {
        ...data.preview,
        jobs,
        waitingForMapping: data.selection.connections
          .filter((row) => !row.mappingConfirmedAt)
          .map((row) => row.id),
        recovery: {
          id: recovery.id,
          expiresAt: expiresAt.toISOString(),
          downloadUrl: `/api/plaid/resets/${recovery.id}/recovery`,
        },
      };
    });
  } catch (error) {
    if (recoveryPath) await rm(recoveryPath, { force: true });
    throw error;
  }
}
