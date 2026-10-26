import { and, desc, eq, isNull, lte, ne } from "drizzle-orm";
import {
  accounts,
  balanceSnapshots,
  snapshotItems,
  bankConnections,
  bankConnectionAccounts,
  journalEntries,
  postings,
  importRows,
  statements,
} from "@/db/schema";
import type { AppDb } from "@/db/types";
import { money } from "@/lib/money";
import { effectiveFromDate, shiftDate } from "@/lib/bank-sync/date-range";

export async function accountPositions(
  db: AppDb,
  ownerId: string,
  today: string,
  options: { includeExisting?: boolean; fromDate?: string; includeSuggestions?: boolean } = {},
) {
  const [owned, observations, records, mappings, connections, undecided] = await Promise.all([
    db
      .select()
      .from(accounts)
      .where(and(eq(accounts.ownerId, ownerId), eq(accounts.isSystem, false))),
    db
      .select({ item: snapshotItems, snapshot: balanceSnapshots })
      .from(snapshotItems)
      .innerJoin(
        balanceSnapshots,
        and(eq(balanceSnapshots.id, snapshotItems.snapshotId), eq(balanceSnapshots.ownerId, ownerId)),
      )
      .where(
        and(
          eq(snapshotItems.ownerId, ownerId),
          eq(snapshotItems.isCurrent, true),
          eq(balanceSnapshots.status, "published"),
          lte(balanceSnapshots.snapshotDate, today),
        ),
      )
      .orderBy(
        desc(balanceSnapshots.snapshotDate),
        desc(balanceSnapshots.updatedAt),
        desc(snapshotItems.createdAt),
      ),
    db
      .select({ entry: journalEntries, line: postings })
      .from(journalEntries)
      .innerJoin(postings, and(eq(postings.journalEntryId, journalEntries.id), eq(postings.ownerId, ownerId)))
      .where(and(eq(journalEntries.ownerId, ownerId), ne(journalEntries.status, "voided"))),
    options.includeSuggestions === false
      ? []
      : db
          .select()
          .from(bankConnectionAccounts)
          .where(
            and(eq(bankConnectionAccounts.ownerId, ownerId), eq(bankConnectionAccounts.isEnabled, true)),
          ),
    options.includeSuggestions === false
      ? []
      : db
          .select()
          .from(bankConnections)
          .where(and(eq(bankConnections.ownerId, ownerId), ne(bankConnections.status, "revoked"))),
    db
      .select({ row: importRows, accountId: statements.accountId })
      .from(importRows)
      .innerJoin(statements, and(eq(statements.id, importRows.statementId), eq(statements.ownerId, ownerId)))
      .where(
        and(
          eq(importRows.ownerId, ownerId),
          isNull(importRows.journalEntryId),
          isNull(importRows.linkedEntryId),
          ne(importRows.decision, "exclude"),
          ne(importRows.upstreamState, "removed"),
          ne(statements.status, "discarded"),
        ),
      ),
  ]);
  return owned.map((account) => {
    const observation = observations.find(({ item }) => item.accountId === account.id);
    const lines = records.filter(({ line }) => line.accountId === account.id);
    const openings = lines.filter(({ entry }) => entry.entryType === "opening_balance");
    const confirmed = lines.filter(({ entry }) => entry.status === "confirmed");
    const total = (rows: typeof records) => rows.reduce((sum, { line }) => sum.plus(line.amount), money("0"));
    const ledger = total(
      confirmed.filter(({ entry }) => (entry.postedDate ?? entry.eventDate) <= today),
    ).toFixed(4);
    const observed = observation
      ? {
          amount: observation.item.balanceNative,
          currency: observation.item.currency,
          date: observation.snapshot.snapshotDate,
          source: observation.snapshot.source,
          observedAt:
            observation.snapshot.source === "plaid"
              ? (observation.item.sourceRef?.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/)?.[0] ??
                observation.item.createdAt.toISOString())
              : observation.snapshot.updatedAt.toISOString(),
          snapshotId: observation.snapshot.id,
          itemId: observation.item.id,
        }
      : null;
    const pendingCount = observed
      ? undecided.filter(
          ({ row, accountId }) =>
            (row.accountId ?? accountId) === account.id &&
            (!(row.postedDate ?? row.transactionDate) ||
              (row.postedDate ?? row.transactionDate)! <= observed.date),
        ).length
      : 0;
    const difference = observed ? money(ledger).minus(observed.amount).toFixed(4) : null;
    const openingSuggestion = () => {
      if (
        options.includeSuggestions === false ||
        !observed ||
        account.type === "asset_security" ||
        (openings.length && !options.includeExisting) ||
        pendingCount
      )
        return null;
      const mapping = mappings.find((row) => row.accountId === account.id);
      const connection = mapping ? connections.find((row) => row.id === mapping.connectionId) : null;
      const flows = confirmed.filter(
        ({ entry }) =>
          (entry.postedDate ?? entry.eventDate) <= observed.date &&
          (!options.includeExisting || entry.entryType !== "opening_balance"),
      );
      const starts = [
        ...confirmed.map(({ entry }) => entry.postedDate ?? entry.eventDate),
        ...(connection && mapping ? [effectiveFromDate(connection, mapping)] : []),
      ];
      const start = options.fromDate ?? starts.sort()[0] ?? observed.date;
      return {
        accountId: account.id,
        currency: account.currency,
        amount: money(observed.amount).minus(total(flows)).toFixed(4),
        syncedBalance: observed.amount,
        syncedFlows: total(flows).toFixed(4),
        eventDate: shiftDate(start, -1),
        observationDate: observed.date,
        rowIds: [...new Set(flows.map(({ entry }) => entry.id))],
        transactionCount: new Set(flows.map(({ entry }) => entry.id)).size,
      };
    };
    return {
      account,
      ledger,
      observed,
      difference,
      pendingCount,
      openingEntryId: openings[0]?.entry.id ?? null,
      hasConfirmedOpening: openings.some(
        ({ entry }) => entry.status === "confirmed" && (entry.postedDate ?? entry.eventDate) <= today,
      ),
      suggestion: openingSuggestion(),
    };
  });
}
export type AccountPosition = Awaited<ReturnType<typeof accountPositions>>[number];
