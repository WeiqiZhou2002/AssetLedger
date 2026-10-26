import { detectBenefit, isMerchantOfferRefund } from "@/lib/benefits/config";
import { and, eq } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import {
  accounts,
  bankConnections,
  bankConnectionAccounts,
  institutions,
  journalEntries,
  postings,
  importRows,
  transferPairRejections,
} from "@/db/schema";
import { money } from "@/lib/money";
import { cashLikeTypes } from "@/lib/ledger/constants";
import { untouched, type ImportRow } from "./auto-state";
import { accountAliases, type SignalLeg } from "./match-signals";
import { ownerSyncDate } from "./observations";
import { effectiveFromDate, shiftDate } from "./date-range";
import { transferPairKey } from "./transfer-pair-keys";

export type MatchCandidate = SignalLeg & {
  clearing: boolean;
  connected: boolean;
  automatic: boolean;
  existing: boolean;
  row: ImportRow | null;
  rescan: boolean;
  inScope: boolean;
  legKey: string;
  suggestionEligible: boolean;
};
export const MATCHING_VERSION = 2;

// Load postings/evidence in batches. No per-entry queries, and no evidence is sent to the browser.
export async function loadMatchPool(db: AppDb, ownerId: string, environment?: string, now = new Date()) {
  const [accountRows, institutionRows, connections, mappings, evidence, records, today, lineage, rejections] =
    await Promise.all([
      db.select().from(accounts).where(eq(accounts.ownerId, ownerId)),
      db.select().from(institutions).where(eq(institutions.ownerId, ownerId)),
      db.select().from(bankConnections).where(eq(bankConnections.ownerId, ownerId)),
      db.select().from(bankConnectionAccounts).where(eq(bankConnectionAccounts.ownerId, ownerId)),
      db.select().from(importRows).where(eq(importRows.ownerId, ownerId)),
      db
        .select({ entry: journalEntries, posting: postings })
        .from(journalEntries)
        .innerJoin(
          postings,
          and(eq(postings.journalEntryId, journalEntries.id), eq(postings.ownerId, ownerId)),
        )
        .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.status, "confirmed"))),
      ownerSyncDate(db, ownerId, now),
      db
        .select({
          id: journalEntries.id,
          replacesEntryId: journalEntries.replacesEntryId,
          autoPosted: journalEntries.autoPosted,
          providerTransactionId: journalEntries.providerTransactionId,
          providerAccountId: journalEntries.providerAccountId,
        })
        .from(journalEntries)
        .where(eq(journalEntries.ownerId, ownerId)),
      db.select().from(transferPairRejections).where(eq(transferPairRejections.ownerId, ownerId)),
    ]);
  const accountMap = new Map(accountRows.map((account) => [account.id, account]));
  const institutionMap = new Map(institutionRows.map((institution) => [institution.id, institution]));
  const connectionMap = new Map(connections.map((connection) => [connection.id, connection]));
  const rowMap = new Map(
    evidence
      .filter((row) => row.source === "plaid" && row.journalEntryId)
      .map((row) => [row.journalEntryId!, row]),
  );
  const ancestors = new Map(lineage.map((entry) => [entry.id, entry]));
  const providerEvidence = new Map<string, { providerId: string; accountId: string | null }>();
  for (const row of evidence) {
    const id = row.journalEntryId ?? row.linkedEntryId;
    if (!id || !row.providerTransactionId) continue;
    const previous = providerEvidence.get(id);
    if (!previous || row.providerTransactionId < previous.providerId)
      providerEvidence.set(id, { providerId: row.providerTransactionId, accountId: row.accountId });
  }
  const legKeys = new Map<string, string>();
  function legKey(id: string, accountId: string) {
    const path: string[] = [];
    const seen = new Set<string>();
    let current = id;
    let key: string | undefined;
    while (!seen.has(current)) {
      seen.add(current);
      path.push(current);
      const entry = ancestors.get(current);
      const evidence = providerEvidence.get(current);
      const providerId = entry?.providerTransactionId ?? evidence?.providerId;
      // Keep the upstream account identity even if an owner corrects the posting account.
      const providerAccountId = entry?.providerAccountId ?? evidence?.accountId ?? accountId;
      key =
        legKeys.get(`${accountId}:${current}`) ??
        (providerId ? `ptx:${providerAccountId}:${providerId}` : undefined);
      if (key || !entry?.replacesEntryId) break;
      current = entry.replacesEntryId;
    }
    key ??= `entry:${current}`;
    for (const item of path) legKeys.set(`${accountId}:${item}`, key);
    return key;
  }
  function inheritedEvidence(id: string) {
    const seen = new Set<string>();
    let parent = ancestors.get(id)?.replacesEntryId;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const original = ancestors.get(parent);
      const row = rowMap.get(parent);
      if (original?.autoPosted && row) return row;
      parent = original?.replacesEntryId;
    }
    return null;
  }
  const groups = new Map<
    string,
    { entry: typeof journalEntries.$inferSelect; lines: (typeof postings.$inferSelect)[] }
  >();
  for (const { entry, posting } of records) {
    const group = groups.get(entry.id) ?? { entry, lines: [] };
    group.lines.push(posting);
    groups.set(entry.id, group);
  }
  const refunded = new Set(
    [...groups.values()].flatMap(({ entry }) => (entry.refundOfEntryId ? [entry.refundOfEntryId] : [])),
  );
  const suggestionFrom = shiftDate(today, -365);
  const context = (accountId: string, row: ImportRow | null) => {
    const account = accountMap.get(accountId)!;
    const mapping = mappings.find(
      (item) => item.accountId === accountId && (!row || item.connectionId === row.bankConnectionId),
    );
    const connection = mapping ? connectionMap.get(mapping.connectionId) : undefined;
    const connected = Boolean(
      mapping?.isEnabled &&
      connection &&
      connection.status !== "revoked" &&
      (!environment || connection.environment === environment),
    );
    const from = connection ? effectiveFromDate(connection, mapping) : "9999-12-31";
    const recent = shiftDate(today, -120);
    return {
      account,
      connection,
      connected,
      from: from < recent ? from : recent,
      aliases: accountAliases({
        institutionName: institutionMap.get(account.institutionId ?? "")?.name,
        plaidInstitutionName: connection?.institutionName,
      }),
      mask: account.last4 ?? mapping?.mask ?? null,
      primary: typeof row?.upstreamPayload?.primary === "string" ? row.upstreamPayload.primary : null,
    };
  };
  const pool: MatchCandidate[] = [];
  for (const { entry, lines } of groups.values()) {
    if (entry.transferMatchId) continue;
    const real = lines.filter((line) => accountMap.get(line.accountId)?.isSystem === false);
    if (real.length !== 1 || !cashLikeTypes.includes(accountMap.get(real[0].accountId)!.type)) continue;
    const own = real[0];
    const directRow = rowMap.get(entry.id);
    const row = directRow ?? inheritedEvidence(entry.id);
    const ownerReplacement = !directRow && Boolean(row);
    const c = context(own.accountId, row);
    const offerRefund = isMerchantOfferRefund({
      amount: own.amount,
      accountType: c.account.type,
      description: `${entry.description ?? ""} ${entry.merchant ?? ""}`,
    });
    const automatic = Boolean(
      !offerRefund &&
      !entry.benefitCredit &&
      !detectBenefit({
        amount: own.amount,
        accountType: c.account.type,
        description: `${entry.description ?? ""} ${entry.merchant ?? ""}`,
        primary: c.primary,
      }) &&
      (entry.autoPosted || ownerReplacement) &&
      row &&
      c.connected &&
      c.connection?.autoPost &&
      row.bankConnectionId === c.connection.id &&
      row.accountId === own.accountId &&
      (entry.postedDate ?? entry.eventDate) >= c.from &&
      ["posted", "upstream", "resolved"].includes(row.autoPostState) &&
      !row.linkedEntryId,
    );
    pool.push({
      id: entry.id,
      legKey: legKey(entry.id, own.accountId),
      suggestionEligible:
        !offerRefund &&
        !["opening_balance", "balance_adjustment"].includes(entry.entryType) &&
        !entry.benefitCredit &&
        !entry.refundOfEntryId &&
        !entry.purchaseGroupId &&
        !refunded.has(entry.id) &&
        (entry.postedDate ?? entry.eventDate) >= suggestionFrom &&
        (entry.postedDate ?? entry.eventDate) <= today &&
        lines.every(
          (line) =>
            line.id === own.id ||
            ["income", "expense", "transfer_clearing"].includes(accountMap.get(line.accountId)?.type ?? ""),
        ),
      accountId: own.accountId,
      accountName: c.account.name,
      accountType: c.account.type,
      amount: own.amount,
      currency: own.currency,
      date: entry.postedDate ?? entry.eventDate,
      eventDate: entry.eventDate,
      description: `${entry.description ?? ""} ${entry.merchant ?? ""}`.trim(),
      canAutoMatch:
        automatic &&
        !ownerReplacement &&
        row?.autoPostState === "posted" &&
        row.upstreamState === "none" &&
        untouched({ ...entry, postings: lines, audit: [], upstream: [], transfer: null }),
      automatic,
      connected: c.connected,
      aliases: c.aliases,
      mask: c.mask,
      primary: c.primary,
      clearing:
        lines.length === 2 &&
        lines.some((line) => accountMap.get(line.accountId)?.type === "transfer_clearing"),
      row,
      existing: true,
      inScope: Boolean(
        row
          ? !environment || connectionMap.get(row.bankConnectionId ?? "")?.environment === environment
          : true,
      ),
      rescan: Boolean(
        c.connection &&
        (c.connection.matchingVersion < MATCHING_VERSION ||
          c.connection.matchingGeneration !== c.connection.syncGeneration),
      ),
    });
  }
  function newCandidate(row: ImportRow): MatchCandidate | null {
    if (!row.accountId || !row.transactionDate || money(row.amount).isZero()) return null;
    const c = context(row.accountId, row);
    if (
      c.account &&
      isMerchantOfferRefund({
        amount: row.amount,
        accountType: c.account.type,
        description: `${row.descriptionRaw} ${row.merchantNormalized}`,
      })
    )
      return null;
    if (
      c.account &&
      detectBenefit({
        amount: row.amount,
        accountType: c.account.type,
        description: `${row.descriptionRaw} ${row.merchantNormalized}`,
        primary: c.primary,
      })
    )
      return null;
    if (!c.account || !c.connected || !c.connection?.autoPost || !cashLikeTypes.includes(c.account.type))
      return null;
    return {
      id: row.id,
      legKey: row.providerTransactionId
        ? `ptx:${row.accountId}:${row.providerTransactionId}`
        : `entry:${row.id}`,
      suggestionEligible: false,
      accountId: row.accountId,
      accountName: c.account.name,
      accountType: c.account.type,
      amount: row.amount,
      currency: row.currency,
      date: row.postedDate ?? row.transactionDate,
      eventDate: row.transactionDate,
      description: `${row.descriptionRaw} ${row.merchantNormalized}`,
      canAutoMatch: true,
      automatic: true,
      connected: true,
      aliases: c.aliases,
      mask: c.mask,
      primary: c.primary,
      clearing: false,
      row,
      existing: false,
      rescan: false,
      inScope: true,
    };
  }
  const rejectedPairs = new Set(rejections.map((row) => transferPairKey(row.leftKey, row.rightKey)));
  return { pool, newCandidate, connections, rejectedPairs, legKey };
}

export function publicLeg(leg: MatchCandidate) {
  // Explicit allowlist: future pool metadata must not silently enter browser payloads.
  return {
    id: leg.id,
    accountId: leg.accountId,
    accountName: leg.accountName,
    accountType: leg.accountType,
    amount: leg.amount,
    currency: leg.currency,
    date: leg.date,
    eventDate: leg.eventDate,
    description: leg.description,
    clearing: leg.clearing,
    canAutoMatch: leg.canAutoMatch,
    connected: leg.connected,
    automatic: leg.automatic,
    existing: leg.existing,
    rescan: leg.rescan,
    inScope: leg.inScope,
  };
}
