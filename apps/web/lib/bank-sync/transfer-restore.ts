import { and, eq } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import { accounts, journalEntries, transferPairConfirmations, transferAccountAssignments } from "@/db/schema";
import { requireAccount } from "@/lib/ledger/accounts";
import { createEntry } from "@/lib/ledger/entries";
import { auditLedger } from "@/lib/ledger/audit";
import { invariant } from "@/lib/ledger/errors";
import { money } from "@/lib/money";
import type { ImportRow } from "./auto-state";
import { loadMatchPool, type MatchCandidate } from "./match-pool";
import { pairType } from "./match-signals";
import { clearingInput, convertToClearing, linkLegs, matchCandidatePair } from "./transfer-legs";
import { assignmentReference } from "./transfer-memory";

export async function assignTransferAccount(
  db: AppDb,
  ownerId: string,
  first: MatchCandidate,
  accountId: string,
) {
  const account = await requireAccount(db, ownerId, accountId);
  invariant(!account.isSystem && account.isActive, "请选择有效的真实账户");
  const other = {
    ...first,
    accountId: account.id,
    accountName: account.name,
    accountType: account.type,
    currency: account.currency,
    amount: money(first.amount).negated().toFixed(4),
  };
  invariant(pairType(first, other), "对方账户的币种、类型或方向不符合还款/转账规则");
  const leg = await convertToClearing(db, ownerId, first, false);
  const counterpart = await createEntry(db, ownerId, {
    ...(await clearingInput(db, ownerId, {
      accountId,
      currency: account.currency,
      amount: other.amount,
      transactionDate: leg.eventDate,
      postedDate: leg.date,
      merchantNormalized: first.description,
      descriptionRaw: "所有者指定转账对方账户",
    })),
    source: "manual",
    externalReference: assignmentReference(first.legKey),
  });
  const transferMatchId = await linkLegs(db, ownerId, leg, { ...other, id: counterpart.id }, false);
  await auditLedger(db, ownerId, "journal_entry", leg.id, "transfer.assigned", {
    accountId,
    counterpartEntryId: counterpart.id,
  });
  return transferMatchId;
}

// Runs under the owner's import lock before heuristic matching. Explicit decisions win;
// unresolved upstream changes and duplicate rows must still be reviewed by the owner.
export async function restoreTransferChoices(
  db: AppDb,
  ownerId: string,
  environment: string,
  options: {
    rows?: ImportRow[];
    canPost?: (row: ImportRow) => Promise<boolean>;
    now?: Date;
  } = {},
) {
  const [loaded, pairs, assignments, owned, tagged] = await Promise.all([
    loadMatchPool(db, ownerId, environment, options.now),
    db.select().from(transferPairConfirmations).where(eq(transferPairConfirmations.ownerId, ownerId)),
    db.select().from(transferAccountAssignments).where(eq(transferAccountAssignments.ownerId, ownerId)),
    db.select().from(accounts).where(eq(accounts.ownerId, ownerId)),
    db
      .select({ id: journalEntries.id, reference: journalEntries.externalReference })
      .from(journalEntries)
      .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.status, "confirmed"))),
  ]);
  const legs = loaded.pool.filter(
    (leg) =>
      leg.inScope && (!leg.row || (leg.row.upstreamState === "none" && leg.row.autoPostState !== "upstream")),
  );
  for (const row of options.rows ?? []) {
    if (
      row.journalEntryId ||
      row.linkedEntryId ||
      row.autoPostState !== "none" ||
      row.decision !== "pending" ||
      row.upstreamState === "removed"
    )
      continue;
    const leg = loaded.newCandidate(row);
    if (leg && (!options.canPost || (await options.canPost(row)))) legs.push(leg);
  }
  const used = new Set<string>();
  const byKey = (key: string) => {
    const found = legs.filter((leg) => leg.legKey === key && !used.has(leg.id));
    return found.length === 1 ? found[0] : null;
  };
  for (const pair of pairs) {
    const a = byKey(pair.leftKey),
      b = byKey(pair.rightKey);
    if (!a || !b || a.id === b.id || !pairType(a, b)) continue;
    await matchCandidatePair(db, ownerId, a, b, false, true);
    used.add(a.id);
    used.add(b.id);
  }
  for (const assignment of assignments) {
    const leg = byKey(assignment.legKey);
    const target = owned.find(
      (account) => account.id === assignment.accountId && account.isActive && !account.isSystem,
    );
    if (
      !leg ||
      !target ||
      !pairType(leg, {
        accountId: target.id,
        accountType: target.type,
        currency: target.currency,
        amount: money(leg.amount).negated().toFixed(4),
      })
    )
      continue;
    const previous = tagged.filter((entry) => entry.reference === assignmentReference(leg.legKey));
    if (previous.length) {
      // A surviving counterpart is evidence. Never create a duplicate if it is matched,
      // edited to an incompatible amount/account, or awaiting upstream review.
      if (previous.length !== 1) continue;
      const peer = legs.find(
        (item) => item.id === previous[0].id && item.accountId === target.id && !used.has(item.id),
      );
      if (!peer || !pairType(leg, peer)) continue;
      await matchCandidatePair(db, ownerId, leg, peer, false, true);
      used.add(peer.id);
    } else {
      await assignTransferAccount(db, ownerId, leg, target.id);
    }
    used.add(leg.id);
  }
  return used.size;
}
