import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import { auditLogs, journalEntries, postings } from "@/db/schema";
export async function suggestedOpeningIds(db: AppDb, ownerId: string) {
  const direct = await db
    .select({ entryId: auditLogs.entityId })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.ownerId, ownerId),
        eq(auditLogs.entityType, "journal_entry"),
        eq(auditLogs.action, "entry.observed_opening"),
      ),
    );
  // Legacy audit JSON was fully redacted. Compare timestamps in PostgreSQL (not millisecond JS dates).
  // Transaction-stable now() ties the suggestion audit to its one account opening; ambiguity is kept.
  const legacy = await db
    .select({ entryId: journalEntries.id, auditId: auditLogs.id })
    .from(auditLogs)
    .innerJoin(
      journalEntries,
      and(
        eq(journalEntries.ownerId, ownerId),
        eq(journalEntries.entryType, "opening_balance"),
        eq(journalEntries.createdAt, auditLogs.createdAt),
      ),
    )
    .innerJoin(postings, and(eq(postings.ownerId, ownerId), eq(postings.journalEntryId, journalEntries.id)))
    .where(
      and(
        eq(auditLogs.ownerId, ownerId),
        inArray(auditLogs.action, ["account.observed_opening", "bank.opening_balance"]),
        or(
          and(eq(auditLogs.entityType, "account"), eq(auditLogs.entityId, postings.accountId)),
          sql`(${auditLogs.entityType} = 'bank_connection_account' and exists(select 1 from bank_connection_accounts m where m.owner_id=${ownerId} and m.id=${auditLogs.entityId} and m.account_id=${postings.accountId}))`,
        ),
      ),
    );
  const grouped = new Map<string, Set<string>>();
  for (const row of legacy) {
    const ids = grouped.get(row.auditId) ?? new Set<string>();
    ids.add(row.entryId);
    grouped.set(row.auditId, ids);
  }
  return new Set([
    ...direct.map((row) => row.entryId),
    ...[...grouped.values()].filter((ids) => ids.size === 1).flatMap((ids) => [...ids]),
  ]);
}
