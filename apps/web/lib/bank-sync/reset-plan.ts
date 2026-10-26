import { and, eq, inArray } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import * as s from "@/db/schema";
import { invariant } from "@/lib/ledger/errors";
import { ownerSyncDate } from "./observations";
import { shiftDate, historyStart, availabilityStart } from "./date-range";
import { resetInput, resetCounts, type ResetConfig } from "./reset-types";
import { suggestedOpeningIds } from "./reset-openings";
import { pendingTransfers } from "./matching";

type Entry = typeof s.journalEntries.$inferSelect;
async function resetSelection(db: AppDb, ownerId: string, config: ResetConfig, input: unknown, now: Date) {
  invariant(config.PLAID_ENABLED === "true", "银行连接未启用", 404);
  const value = resetInput.parse(input);
  const today = await ownerSyncDate(db, ownerId, now);
  const from = value.from ?? historyStart(config, today);
  invariant(from >= shiftDate(today, -730) && from <= today, "起始日期须在本地今天之前的 730 天内");
  const connections = await db
    .select()
    .from(s.bankConnections)
    .where(
      and(
        eq(s.bankConnections.ownerId, ownerId),
        eq(s.bankConnections.environment, config.PLAID_ENV),
        eq(s.bankConnections.status, "active"),
        ...(value.connections === "all" ? [] : [inArray(s.bankConnections.id, value.connections)]),
      ),
    );
  invariant(
    connections.length > 0 &&
      (value.connections === "all" || connections.length === new Set(value.connections).size),
    "请选择当前环境中属于您的活跃连接",
    404,
  );
  return {
    ...value,
    from,
    connections: await Promise.all(
      connections.map(async (connection) => ({
        ...connection,
        availabilityStart: availabilityStart(
          await ownerSyncDate(db, ownerId, connection.createdAt),
          connection.daysRequested,
        ),
      })),
    ),
  };
}

// Traverse ancestry and replacements, but never absorb a different connection's independent leg.
function lineage(seeds: Set<string>, entries: Entry[], protectedIds = new Set<string>()) {
  const result = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (!entry.replacesEntryId) continue;
      if (
        result.has(entry.id) &&
        !protectedIds.has(entry.replacesEntryId) &&
        !result.has(entry.replacesEntryId)
      ) {
        result.add(entry.replacesEntryId);
        changed = true;
      }
      if (result.has(entry.replacesEntryId) && !protectedIds.has(entry.id) && !result.has(entry.id)) {
        result.add(entry.id);
        changed = true;
      }
    }
  }
  return result;
}
export async function collectReset(
  db: AppDb,
  ownerId: string,
  config: ResetConfig,
  input: unknown,
  now: Date,
) {
  const selection = await resetSelection(db, ownerId, config, input, now);
  const connectionIds = new Set(selection.connections.map((row) => row.id));
  const [accounts, mappings, entries, lines, rows, statements, audits, jobs, items, snapshots] =
    await Promise.all([
      db.select().from(s.accounts).where(eq(s.accounts.ownerId, ownerId)),
      db.select().from(s.bankConnectionAccounts).where(eq(s.bankConnectionAccounts.ownerId, ownerId)),
      db.select().from(s.journalEntries).where(eq(s.journalEntries.ownerId, ownerId)),
      db.select().from(s.postings).where(eq(s.postings.ownerId, ownerId)),
      db.select().from(s.importRows).where(eq(s.importRows.ownerId, ownerId)),
      db.select().from(s.statements).where(eq(s.statements.ownerId, ownerId)),
      db.select().from(s.auditLogs).where(eq(s.auditLogs.ownerId, ownerId)),
      db.select().from(s.importJobs).where(eq(s.importJobs.ownerId, ownerId)),
      db.select().from(s.snapshotItems).where(eq(s.snapshotItems.ownerId, ownerId)),
      db.select().from(s.balanceSnapshots).where(eq(s.balanceSnapshots.ownerId, ownerId)),
    ]);
  const containers = statements.filter(
    (row) => row.source === "plaid" && row.connectionId && connectionIds.has(row.connectionId),
  );
  const containerIds = new Set(containers.map((row) => row.id));
  const removedRows = rows.filter(
    (row) =>
      row.source === "plaid" &&
      ((row.bankConnectionId && connectionIds.has(row.bankConnectionId)) ||
        containerIds.has(row.statementId)),
  );
  const rowIds = new Set(removedRows.map((row) => row.id));
  const selectedMappings = mappings.filter((row) => connectionIds.has(row.connectionId));
  const accountIds = new Set(
    selectedMappings
      .flatMap((row) => [row.accountId, row.securityAccountId])
      .filter((id): id is string => Boolean(id)),
  );
  for (const row of removedRows) if (row.accountId) accountIds.add(row.accountId);
  const creator = new Map(rows.filter((row) => row.journalEntryId).map((row) => [row.journalEntryId!, row]));
  const protectedIds = new Set(
    rows.filter((row) => !rowIds.has(row.id) && row.journalEntryId).map((row) => row.journalEntryId!),
  );
  const seeds = new Set(removedRows.flatMap((row) => (row.journalEntryId ? [row.journalEntryId] : [])));
  // Before leg-based matching, two bank rows could share one payment entry.
  for (const row of removedRows) {
    if (!row.linkedEntryId || !row.accountId) continue;
    const origin = creator.get(row.linkedEntryId);
    if (
      origin?.source === "plaid" &&
      origin.accountId !== row.accountId &&
      lines.some((line) => line.journalEntryId === row.linkedEntryId && line.accountId === row.accountId)
    ) {
      seeds.add(row.linkedEntryId);
      protectedIds.delete(row.linkedEntryId);
    }
  }
  const plaidEntryIds = lineage(seeds, entries, protectedIds);
  const openingSeeds = await suggestedOpeningIds(db, ownerId);
  const suggestedIds = lineage(openingSeeds, entries);
  const openings = entries.filter(
    (entry) =>
      entry.entryType === "opening_balance" &&
      lines.some((line) => line.journalEntryId === entry.id && accountIds.has(line.accountId)),
  );
  const removedOpenings = openings.filter((entry) => suggestedIds.has(entry.id) && !selection.keepOpenings);
  const entryIds = new Set([...plaidEntryIds, ...removedOpenings.map((row) => row.id)]);
  const removedEntries = entries.filter((row) => entryIds.has(row.id));
  const deletedLines = lines.filter((row) => entryIds.has(row.journalEntryId));
  const matchIds = new Set(
    removedEntries.flatMap((row) => (row.transferMatchId ? [row.transferMatchId] : [])),
  );
  const survivingPeers = entries.filter(
    (row) => !entryIds.has(row.id) && row.transferMatchId && matchIds.has(row.transferMatchId),
  );
  const survivingRefunds = entries.filter(
    (row) => !entryIds.has(row.id) && row.refundOfEntryId && entryIds.has(row.refundOfEntryId),
  );
  const survivingReplacements = entries.filter(
    (row) => !entryIds.has(row.id) && row.replacesEntryId && entryIds.has(row.replacesEntryId),
  );
  const observed = items.filter(
    (row) =>
      row.accountId &&
      accountIds.has(row.accountId) &&
      snapshots.some((snapshot) => snapshot.id === row.snapshotId && snapshot.source === "plaid"),
  );
  const affectedJobs = jobs.filter(
    (row) =>
      (row.connectionId && connectionIds.has(row.connectionId)) ||
      (row.statementId && containerIds.has(row.statementId)),
  );
  const liveJobs = affectedJobs.filter((row) => ["running", "queued"].includes(row.status));
  const realAccountIds = new Set(accounts.filter((row) => !row.isSystem).map((row) => row.id));
  const preserveLegacyEntries = new Map<string, string>();
  const legacyEvidence = rows.filter(
    (row) =>
      !rowIds.has(row.id) &&
      row.source === "plaid" &&
      row.accountId &&
      !accountIds.has(row.accountId) &&
      entryIds.has(row.journalEntryId ?? row.linkedEntryId ?? ""),
  );
  for (const row of legacyEvidence) {
    const family = lineage(new Set([(row.journalEntryId ?? row.linkedEntryId)!]), entries);
    const current = removedEntries.filter(
      (entry) =>
        family.has(entry.id) &&
        entry.status === "confirmed" &&
        lines.some((line) => line.journalEntryId === entry.id && line.accountId === row.accountId),
    );
    invariant(current.length <= 1, "跨连接旧分录存在多个有效替换，请先核对后再重置", 409);
    if (current[0]) preserveLegacyEntries.set(row.id, current[0].id);
  }
  const preserveLegacyRows = legacyEvidence.filter((row) => preserveLegacyEntries.has(row.id));
  const unsupportedLines = deletedLines.filter(
    (line) =>
      realAccountIds.has(line.accountId) &&
      !accountIds.has(line.accountId) &&
      !preserveLegacyRows.some(
        (row) =>
          row.accountId === line.accountId && preserveLegacyEntries.get(row.id) === line.journalEntryId,
      ),
  );
  const pendingIds = new Set(
    removedRows
      .filter(
        (row) =>
          ["duplicate", "upstream"].includes(row.autoPostState) ||
          (row.decision === "pending" && !row.journalEntryId && !row.linkedEntryId),
      )
      .map((row) => row.id),
  );
  const pendingEntryIds = new Set(
    (await pendingTransfers(db, ownerId, config.PLAID_ENV)).map((leg) => leg.id),
  );
  const countsFor = (
    ids: Set<string>,
    subsetRows: typeof rows,
    subsetAccounts: Set<string>,
    statementCount: number,
    jobCount: number,
  ) =>
    resetCounts({
      entries_deleted: entries.filter((entry) => ids.has(entry.id)).length,
      postings_deleted: lines.filter((line) => ids.has(line.journalEntryId)).length,
      rows_deleted: subsetRows.length,
      containers_deleted: statementCount,
      pending_deleted:
        subsetRows.filter((row) => pendingIds.has(row.id)).length +
        [...ids].filter((id) => pendingEntryIds.has(id)).length,
      transfer_links_unlinked:
        survivingPeers.filter((peer) =>
          removedEntries.some((entry) => ids.has(entry.id) && entry.transferMatchId === peer.transferMatchId),
        ).length + preserveLegacyRows.filter((row) => ids.has(preserveLegacyEntries.get(row.id)!)).length,
      refund_links_cleared: survivingRefunds.filter((row) => ids.has(row.refundOfEntryId!)).length,
      purchase_group_links_removed: removedEntries.filter((row) => ids.has(row.id) && row.purchaseGroupId)
        .length,
      suggested_openings_deleted: removedOpenings.filter((entry) => ids.has(entry.id)).length,
      suggested_openings_kept: openings.filter(
        (entry) =>
          suggestedIds.has(entry.id) &&
          selection.keepOpenings &&
          lines.some((line) => line.journalEntryId === entry.id && subsetAccounts.has(line.accountId)),
      ).length,
      other_openings_kept: openings.filter(
        (entry) =>
          !suggestedIds.has(entry.id) &&
          lines.some((line) => line.journalEntryId === entry.id && subsetAccounts.has(line.accountId)),
      ).length,
      observations_deleted: selection.deleteObservations
        ? observed.filter((row) => subsetAccounts.has(row.accountId!)).length
        : 0,
      observations_kept: selection.deleteObservations
        ? 0
        : observed.filter((row) => subsetAccounts.has(row.accountId!)).length,
      jobs_superseded: jobCount,
      unsupported_counterparts_deleted: unsupportedLines.filter((line) => ids.has(line.journalEntryId))
        .length,
    });
  const totals = countsFor(entryIds, removedRows, accountIds, containers.length, liveJobs.length);
  const preview = {
    from: selection.from,
    keepOpenings: selection.keepOpenings,
    deleteObservations: selection.deleteObservations,
    totals,
    connections: selection.connections.map((connection) => {
      const ownRows = removedRows.filter(
        (row) =>
          row.bankConnectionId === connection.id ||
          containers.some(
            (container) => container.id === row.statementId && container.connectionId === connection.id,
          ),
      );
      const ownAccounts = new Set(
        [
          ...selectedMappings
            .filter((row) => row.connectionId === connection.id)
            .flatMap((row) => [row.accountId, row.securityAccountId]),
          ...ownRows.map((row) => row.accountId),
        ].filter((id): id is string => Boolean(id)),
      );
      const ownIds = new Set(
        removedEntries
          .filter((entry) =>
            lines.some((line) => line.journalEntryId === entry.id && ownAccounts.has(line.accountId)),
          )
          .map((entry) => entry.id),
      );
      const ancestry = lineage(
        new Set(
          ownRows.flatMap((row) =>
            row.journalEntryId
              ? [row.journalEntryId]
              : row.linkedEntryId && entryIds.has(row.linkedEntryId)
                ? [row.linkedEntryId]
                : [],
          ),
        ),
        entries,
        protectedIds,
      );
      for (const id of ancestry) if (entryIds.has(id)) ownIds.add(id);
      // Owner replacements may have moved a Plaid-created entry to another account.
      // Show all affected posting accounts without expanding the opening/observation deletion scope.
      for (const line of lines)
        if (ownIds.has(line.journalEntryId) && realAccountIds.has(line.accountId))
          ownAccounts.add(line.accountId);
      const ownJobs = liveJobs.filter((job) => job.connectionId === connection.id);
      return {
        connectionId: connection.id,
        currentFrom: connection.importFromDate,
        transactionsAvailable: connection.products.includes("transactions"),
        availabilityStart: connection.availabilityStart,
        mapped: Boolean(connection.mappingConfirmedAt),
        counts: countsFor(
          ownIds,
          ownRows,
          ownAccounts,
          containers.filter((row) => row.connectionId === connection.id).length,
          ownJobs.length,
        ),
        jobs: ownJobs.map(({ id, status }) => ({ id, status })),
        accounts: [...ownAccounts].map((accountId) => {
          const ids = new Set(
            removedEntries
              .filter((entry) =>
                lines.some((line) => line.journalEntryId === entry.id && line.accountId === accountId),
              )
              .map((entry) => entry.id),
          );
          return {
            accountId,
            counts: countsFor(
              ids,
              ownRows.filter((row) => row.accountId === accountId),
              new Set([accountId]),
              0,
              0,
            ),
            openings: openings
              .filter((entry) =>
                lines.some((line) => line.journalEntryId === entry.id && line.accountId === accountId),
              )
              .map((entry) => ({
                id: entry.id,
                date: entry.postedDate ?? entry.eventDate,
                status: entry.status,
                suggested: suggestedIds.has(entry.id),
                deleting: entryIds.has(entry.id),
              })),
          };
        }),
      };
    }),
  };
  return {
    selection,
    preview,
    accounts,
    entries,
    lines,
    rows,
    audits,
    containers,
    removedRows,
    rowIds,
    entryIds,
    removedEntries,
    deletedLines,
    removedOpenings,
    survivingPeers,
    survivingRefunds,
    survivingReplacements,
    preserveLegacyRows,
    preserveLegacyEntries,
    observed,
    observationSnapshots: snapshots.filter((snapshot) =>
      observed.some((item) => item.snapshotId === snapshot.id),
    ),
    affectedJobs,
    accountIds,
  };
}
export type ResetData = Awaited<ReturnType<typeof collectReset>>;
