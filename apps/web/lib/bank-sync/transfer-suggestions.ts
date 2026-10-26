import { z } from "zod";
import type { AppDb } from "@/db/types";
import { importLock } from "@/lib/imports/store";
import { auditLedger } from "@/lib/ledger/audit";
import { invariant } from "@/lib/ledger/errors";
import { amountIndex, dateDistance, pairType } from "./match-signals";
import { loadMatchPool, publicLeg } from "./match-pool";
import { rememberTransferRejection } from "./transfer-memory";
import { transferPairKey } from "./transfer-pair-keys";
import { matchCandidatePair } from "./transfer-legs";

type MatchPool = Awaited<ReturnType<typeof loadMatchPool>>;

// Pure graph computation over one owner-scoped pool; no environment/automatic filter.
export function computeTransferSuggestions({
  pool,
  rejectedPairs,
}: Pick<MatchPool, "pool" | "rejectedPairs">) {
  const eligible = pool.filter((leg) => leg.existing && leg.suggestionEligible);
  const sameAmount = amountIndex(eligible);
  const pairs: {
    key: string;
    left: ReturnType<typeof publicLeg>;
    right: ReturnType<typeof publicLeg>;
    type: NonNullable<ReturnType<typeof pairType>>;
    days: number;
  }[] = [];
  const counts = new Map<string, number>();
  for (const a of eligible) {
    for (const b of sameAmount(a)) {
      if (a.id >= b.id || a.legKey === b.legKey || (a.clearing && b.clearing)) continue;
      const type = pairType(a, b);
      if (!type) continue;
      const days = dateDistance(a, b);
      if (days > 5) continue;
      const key = transferPairKey(a.legKey, b.legKey);
      if (rejectedPairs.has(key)) continue;
      pairs.push({ key, left: publicLeg(a), right: publicLeg(b), type, days });
      counts.set(a.id, (counts.get(a.id) ?? 0) + 1);
      counts.set(b.id, (counts.get(b.id) ?? 0) + 1);
    }
  }
  const latest = (pair: (typeof pairs)[number]) =>
    pair.left.date > pair.right.date ? pair.left.date : pair.right.date;
  return pairs
    .sort((a, b) => latest(b).localeCompare(latest(a)) || a.days - b.days || a.key.localeCompare(b.key))
    .map((pair) => ({ ...pair, alternatives: counts.get(pair.left.id)! + counts.get(pair.right.id)! - 2 }));
}

export async function transferSuggestions(db: AppDb, ownerId: string) {
  return computeTransferSuggestions(await loadMatchPool(db, ownerId));
}

const suggestionAction = z
  .object({
    action: z.enum(["confirm", "reject"]),
    entryId: z.uuid(),
    counterpartEntryId: z.uuid(),
  })
  .strict();

export async function resolveTransferSuggestion(db: AppDb, ownerId: string, input: unknown) {
  const action = suggestionAction.parse(input);
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const loaded = await loadMatchPool(tx, ownerId);
    const suggestion = computeTransferSuggestions(loaded).find(
      (pair) =>
        (pair.left.id === action.entryId && pair.right.id === action.counterpartEntryId) ||
        (pair.right.id === action.entryId && pair.left.id === action.counterpartEntryId),
    );
    invariant(suggestion, "建议已失效，请刷新", 404);
    const a = loaded.pool.find((leg) => leg.id === suggestion.left.id)!;
    const b = loaded.pool.find((leg) => leg.id === suggestion.right.id)!;
    let transferMatchId: string | null = null;
    if (action.action === "confirm") {
      transferMatchId = await matchCandidatePair(tx, ownerId, a, b, false);
    } else {
      await rememberTransferRejection(tx, ownerId, a.legKey, b.legKey);
    }
    // Each original is an audit entity; no descriptions, amounts or provider keys are logged.
    for (const entryId of [a.id, b.id]) {
      await auditLedger(
        tx,
        ownerId,
        "journal_entry",
        entryId,
        action.action === "confirm" ? "transfer.suggestion_confirmed" : "transfer.suggestion_rejected",
      );
    }
    return { transferMatchId };
  });
}
