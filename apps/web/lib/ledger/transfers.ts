import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { accounts, journalEntries, postings } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { money } from "@/lib/money";

const peer = alias(journalEntries, "transfer_peer");
export function transferPeerExists(ownerId: string, condition?: (entry: typeof peer) => SQL | undefined) {
  return sql`(${journalEntries.status} = 'confirmed' and ${journalEntries.transferMatchId} is not null and exists (
    select 1 from ${journalEntries} as ${peer} where ${peer.ownerId} = ${ownerId} and ${peer.status} = 'confirmed'
    and ${peer.transferMatchId} = ${journalEntries.transferMatchId} and ${peer.id} <> ${journalEntries.id}
    and ${condition?.(peer) ?? sql`true`}
  ))`;
}
// Filter before LIMIT/OFFSET and count: only the real-account outflow represents a pair.
export function representativeEntry(ownerId: string) {
  return sql`(not ${transferPeerExists(ownerId)} or exists (
    select 1 from ${postings} inner join ${accounts} on ${accounts.id} = ${postings.accountId}
    and ${accounts.ownerId} = ${ownerId} and ${accounts.isSystem} = false
    where ${postings.ownerId} = ${ownerId} and ${postings.journalEntryId} = ${journalEntries.id}
    and ${postings.amount} < 0
  ))`;
}
type TransferSide = { entryId: string; accountName: string; date: string; description: string };
type MatchedTransfer = {
  matchId: string;
  type: "credit_card_payment" | "transfer";
  from: TransferSide;
  to: TransferSide;
  amount: string;
  currency: string;
};
export async function loadMatchedTransfers(db: AppDb, ownerId: string, matchIds: string[]) {
  const result = new Map<string, MatchedTransfer>();
  if (!matchIds.length) return result;
  const rows = await db
    .select({ entry: journalEntries, posting: postings, accountName: accounts.name })
    .from(journalEntries)
    .innerJoin(postings, and(eq(postings.journalEntryId, journalEntries.id), eq(postings.ownerId, ownerId)))
    .innerJoin(
      accounts,
      and(eq(accounts.id, postings.accountId), eq(accounts.ownerId, ownerId), eq(accounts.isSystem, false)),
    )
    .where(
      and(
        eq(journalEntries.ownerId, ownerId),
        eq(journalEntries.status, "confirmed"),
        inArray(journalEntries.transferMatchId, [...new Set(matchIds)]),
      ),
    );
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const id = row.entry.transferMatchId!;
    const group = groups.get(id) ?? [];
    group.push(row);
    groups.set(id, group);
  }
  for (const [matchId, legs] of groups) {
    const from = legs.find(({ posting }) => money(posting.amount).lt(0));
    const to = legs.find(({ posting }) => money(posting.amount).gt(0));
    if (
      legs.length !== 2 ||
      !from ||
      !to ||
      from.entry.id === to.entry.id ||
      from.posting.currency !== to.posting.currency ||
      !money(from.posting.amount).plus(to.posting.amount).isZero()
    )
      continue;
    const side = ({ entry, accountName }: (typeof rows)[number]): TransferSide => ({
      entryId: entry.id,
      accountName,
      date: entry.postedDate ?? entry.eventDate,
      description: entry.description || entry.merchant || "",
    });
    result.set(matchId, {
      matchId,
      type: from.entry.entryType === "credit_card_payment" ? "credit_card_payment" : "transfer",
      from: side(from),
      to: side(to),
      amount: money(from.posting.amount).abs().toFixed(4),
      currency: from.posting.currency,
    });
  }
  return result;
}
