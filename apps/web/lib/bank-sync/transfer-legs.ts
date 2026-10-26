import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import { accounts, bankConnections, importRows, journalEntries } from "@/db/schema";
import { getSystemAccount } from "@/lib/ledger/accounts";
import { createEntry, getEntry, replaceEntry } from "@/lib/ledger/entries";
import { auditLedger } from "@/lib/ledger/audit";
import type { EntryInput } from "@/lib/ledger/schemas";
import { invariant } from "@/lib/ledger/errors";
import { money } from "@/lib/money";
import { stampAutoEntry, untouched, updateAutoRow, type ImportRow } from "./auto-state";

import { pairType, dateDistance, strongestCandidates, amountIndex } from "./match-signals";
import { loadMatchPool, MATCHING_VERSION, type MatchCandidate } from "./match-pool";
import { fallbackClearingLeg } from "./transfer-fallback";
import { forgetTransferChoices, rememberTransferPair } from "./transfer-memory";
import { transferPairKey } from "./transfer-pair-keys";

export async function clearingInput(
  db: AppDb,
  ownerId: string,
  row: Pick<
    ImportRow,
    | "accountId"
    | "currency"
    | "amount"
    | "transactionDate"
    | "postedDate"
    | "merchantNormalized"
    | "descriptionRaw"
  >,
): Promise<EntryInput> {
  invariant(row.accountId && row.transactionDate, "转账缺少账户或日期");
  const clearing = await getSystemAccount(db, ownerId, "transfer_clearing", row.currency);
  return {
    entryType: "transfer",
    status: "confirmed",
    source: "import",
    eventDate: row.transactionDate,
    postedDate: row.postedDate,
    merchant: row.merchantNormalized,
    description: row.descriptionRaw,
    postings: [
      { accountId: row.accountId, currency: row.currency, amount: row.amount },
      { accountId: clearing.id, currency: row.currency, amount: money(row.amount).negated().toFixed(4) },
    ],
  };
}
export type Leg = {
  id: string;
  accountId: string;
  accountName: string;
  accountType: typeof accounts.$inferSelect.type;
  amount: string;
  currency: string;
  date: string;
  eventDate: string;
  description: string;
  canAutoMatch: boolean;
};
export async function unmatchedLegs(db: AppDb, ownerId: string, environment?: string): Promise<Leg[]> {
  const { pool } = await loadMatchPool(db, ownerId, environment);
  return pool.filter((leg) => leg.clearing && (!environment || leg.inScope));
}

export async function linkLegs(
  db: AppDb,
  ownerId: string,
  a: Leg,
  b: Leg,
  automatic: boolean,
  remembered = false,
) {
  const type = pairType(a, b);
  invariant(
    type && (remembered || dateDistance(a, b) <= (automatic ? 5 : 7)),
    "配对须不同账户、同币种反向等额，日期超出配对窗口（自动五天 / 手动七天）",
  );
  const ids = [a.id, b.id];
  const rows = await db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.ownerId, ownerId), inArray(journalEntries.id, ids)))
    .orderBy(journalEntries.id)
    .for("update");
  invariant(
    rows.length === 2 && rows.every((row) => row.status === "confirmed" && !row.transferMatchId),
    "转账状态已改变，请刷新",
    409,
  );
  if (automatic) {
    for (const id of ids) invariant(untouched(await getEntry(db, ownerId, id)), "流水已被编辑，请刷新", 409);
  }
  const transferMatchId = randomUUID();
  await db
    .update(journalEntries)
    .set({ entryType: type, transferMatchId })
    .where(and(eq(journalEntries.ownerId, ownerId), inArray(journalEntries.id, ids)));
  for (const id of ids) {
    await stampAutoEntry(db, ownerId, id, !automatic);
    await auditLedger(db, ownerId, "journal_entry", id, automatic ? "auto_matched" : "transfer.matched", {
      transferMatchId,
      entryIds: ids,
    });
  }
  return transferMatchId;
}
// The caller holds the owner's import lock. Preserve each side's bank date and evidence.
export async function convertToClearing(
  db: AppDb,
  ownerId: string,
  candidate: MatchCandidate,
  automatic: boolean,
) {
  if (candidate.existing && candidate.clearing) return candidate;
  const original = candidate.existing ? await getEntry(db, ownerId, candidate.id) : null;
  invariant(
    !original || (original.status === "confirmed" && !original.transferMatchId),
    "流水状态已改变",
    409,
  );
  if (automatic && original) invariant(untouched(original), "流水已被编辑，请刷新", 409);
  const input = {
    ...(await clearingInput(db, ownerId, {
      accountId: candidate.accountId,
      currency: candidate.currency,
      amount: candidate.amount,
      transactionDate: candidate.eventDate,
      postedDate: candidate.date,
      merchantNormalized: original?.merchant ?? candidate.row?.merchantNormalized ?? "",
      descriptionRaw: original?.description ?? candidate.row?.descriptionRaw ?? candidate.description,
    })),
    source: original?.source ?? ("import" as const),
    notes: original?.notes ?? null,
    externalReference: original?.externalReference ?? (candidate.row ? null : "transfer:manual"),
    isSummary: original?.isSummary ?? false,
  };
  const entry = original
    ? await replaceEntry(
        db,
        ownerId,
        original.id,
        input,
        automatic ? "自动重新匹配为转账" : "所有者匹配为转账",
      )
    : await createEntry(db, ownerId, input);
  const providerTransactionId = original?.providerTransactionId ?? candidate.row?.providerTransactionId;
  if (providerTransactionId)
    await db
      .update(journalEntries)
      .set({
        providerTransactionId,
        providerAccountId: candidate.accountId,
      })
      .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, entry.id)));
  await stampAutoEntry(db, ownerId, entry.id, !automatic);
  if (original) {
    await db
      .update(importRows)
      .set({ journalEntryId: entry.id })
      .where(and(eq(importRows.ownerId, ownerId), eq(importRows.journalEntryId, original.id)));
    await db
      .update(importRows)
      .set({ linkedEntryId: entry.id })
      .where(and(eq(importRows.ownerId, ownerId), eq(importRows.linkedEntryId, original.id)));
  }
  if (candidate.row)
    await updateAutoRow(db, ownerId, candidate.row.id, {
      journalEntryId: entry.id,
      linkedEntryId: null,
      decision: "approve",
      autoPostState: "posted",
      upstreamState: "none",
      reviewedAt: new Date(),
      duplicateResolution: "distinct",
      duplicateCandidateEntryIds: [],
      duplicateCandidateRowIds: [],
      suggestedEntryType: "transfer",
      suggestedCategoryId: null,
    });
  await auditLedger(
    db,
    ownerId,
    "journal_entry",
    entry.id,
    original ? "transfer.converted" : "bank.auto_posted",
    { originalEntryId: original?.id ?? null, rowId: candidate.row?.id ?? null },
  );
  return { ...candidate, id: entry.id, existing: true, clearing: true };
}
export async function matchCandidatePair(
  db: AppDb,
  ownerId: string,
  a: MatchCandidate,
  b: MatchCandidate,
  automatic: boolean,
  remembered = false,
) {
  invariant(
    pairType(a, b) && (remembered || dateDistance(a, b) <= (automatic ? 5 : 7)),
    "请选择不同账户、同币种反向等额且在日期窗口内的流水",
  );
  // Lock both originals before converting either side; competing metadata edits cannot slip through.
  const ids = [a, b].filter((leg) => leg.existing).map((leg) => leg.id);
  if (ids.length)
    await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.ownerId, ownerId), inArray(journalEntries.id, ids)))
      .orderBy(journalEntries.id)
      .for("update");
  const first = await convertToClearing(db, ownerId, a, automatic);
  const second = await convertToClearing(db, ownerId, b, automatic);
  const matchId = await linkLegs(db, ownerId, first, second, automatic, remembered);
  if (!automatic && !remembered) await rememberTransferPair(db, ownerId, a.legKey, b.legKey);
  if (automatic && [a, b].some((leg) => leg.existing && !leg.clearing)) {
    for (const [original, leg] of [
      [a, first],
      [b, second],
    ]) {
      await auditLedger(db, ownerId, "journal_entry", leg.id, "auto_rematched_transfer", {
        transferMatchId: matchId,
        originalEntryId: original.existing ? original.id : null,
        rowId: original.row?.id ?? null,
      });
    }
  }
  return matchId;
}
export async function matchUniqueLegs(
  db: AppDb,
  ownerId: string,
  environment: string,
  options: {
    rows?: ImportRow[];
    canPost?: (row: ImportRow) => Promise<boolean>;
    now?: Date;
    changedEntryIds?: Set<string>;
  } = {},
) {
  const { pool, newCandidate, connections, rejectedPairs } = await loadMatchPool(
    db,
    ownerId,
    environment,
    options.now,
  );
  const legs = pool.filter((leg) => leg.automatic);
  for (const row of options.rows ?? []) {
    if (
      row.journalEntryId ||
      row.linkedEntryId ||
      row.autoPostState !== "none" ||
      row.decision !== "pending" ||
      row.upstreamState === "removed"
    )
      continue;
    const candidate = newCandidate(row);
    if (candidate && (!options.canPost || (await options.canPost(row)))) legs.push(candidate);
  }
  // Compute the whole graph once: never remove an ambiguous candidate and then guess on a later pass.
  const sameAmount = amountIndex(legs);
  // Remove rejected edges on BOTH sides before scoring. Keep all other nodes, including
  // their competing edges, so a rejection cannot accidentally bypass mutual uniqueness.
  const choices = new Map(
    legs.map((leg) => [
      leg.id,
      strongestCandidates(
        leg,
        sameAmount(leg).filter((other) => !rejectedPairs.has(transferPairKey(leg.legKey, other.legKey))),
      ),
    ]),
  );
  const used = new Set<string>();
  for (const leg of legs) {
    const others = choices.get(leg.id)!;
    if (used.has(leg.id) || !leg.canAutoMatch || others.length !== 1) continue;
    const other = others[0];
    if (
      !other.canAutoMatch ||
      choices.get(other.id)?.length !== 1 ||
      choices.get(other.id)?.[0].id !== leg.id
    )
      continue;
    if (
      leg.existing &&
      other.existing &&
      !leg.rescan &&
      !other.rescan &&
      !leg.clearing &&
      !other.clearing &&
      !options.changedEntryIds?.has(leg.id) &&
      !options.changedEntryIds?.has(other.id)
    )
      continue;
    await matchCandidatePair(db, ownerId, leg, other, true);
    used.add(leg.id);
    used.add(other.id);
  }
  for (const connection of connections) {
    if (connection.environment !== environment || !connection.autoPost || connection.status === "revoked")
      continue;
    await db
      .update(bankConnections)
      .set({ matchingVersion: MATCHING_VERSION, matchingGeneration: connection.syncGeneration })
      .where(and(eq(bankConnections.ownerId, ownerId), eq(bankConnections.id, connection.id)));
  }
  return used.size / 2;
}
export async function unlinkLeg(
  db: AppDb,
  ownerId: string,
  entryId: string,
  ownerAction = false,
  preserveTarget = false,
) {
  const entry = await getEntry(db, ownerId, entryId);
  if (!entry.transferMatchId) return;
  const peers = await db
    .select()
    .from(journalEntries)
    .where(
      and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.transferMatchId, entry.transferMatchId)),
    )
    .orderBy(journalEntries.id)
    .for("update");
  if (ownerAction) {
    const [{ legKey }, owned] = await Promise.all([
      loadMatchPool(db, ownerId),
      db.select().from(accounts).where(eq(accounts.ownerId, ownerId)),
    ]);
    const keys: string[] = [];
    for (const peer of peers) {
      const detail = await getEntry(db, ownerId, peer.id);
      // All pair legs have one real account; provider identity is resolved before any rewrite.
      const own = detail.postings.find((line) =>
        owned.some((account) => account.id === line.accountId && !account.isSystem),
      );
      if (own) keys.push(legKey(peer.id, own.accountId));
    }
    await forgetTransferChoices(db, ownerId, keys);
  }
  for (const peer of peers) {
    const ownerEdited = ownerAction || !untouched(await getEntry(db, ownerId, peer.id));
    await db
      .update(journalEntries)
      .set({ transferMatchId: null, entryType: "transfer" })
      .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, peer.id)));
    await auditLedger(db, ownerId, "journal_entry", peer.id, "transfer.unmatched", {
      changedEntryId: entryId,
    });
    if (peer.status === "confirmed" && !(preserveTarget && peer.id === entryId))
      await fallbackClearingLeg(db, ownerId, peer.id, ownerEdited);
  }
}
