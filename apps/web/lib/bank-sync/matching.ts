import { and, eq } from "drizzle-orm";
import { accounts } from "@/db/schema";
import { money } from "@/lib/money";
import { z } from "zod";
import type { AppDb } from "@/db/types";
import { importLock } from "@/lib/imports/store";
import { getEntry } from "@/lib/ledger/entries";
import { invariant } from "@/lib/ledger/errors";
import {
  amountIndex,
  candidatesFor,
  dateDistance,
  pairType,
  signalStrength,
  strongestCandidates,
} from "./match-signals";
import { loadMatchPool, publicLeg, type MatchCandidate } from "./match-pool";
import { assignTransferAccount } from "./transfer-restore";
import { rememberTransferAssignment } from "./transfer-memory";
import { matchCandidatePair, unlinkLeg } from "./transfer-legs";

function matchDiagnostics(leg: MatchCandidate, pool: MatchCandidate[]) {
  const sameAmount = pool.filter((other) => other.id !== leg.id && pairType(leg, other));
  const automatic = pool.filter((other) => other.automatic);
  const best = strongestCandidates(leg, automatic);
  const messages: string[] = [];
  if (!sameAmount.length) messages.push("没有反向同额候选；对方账户可能尚未连接或历史流水尚未同步");
  if (best.length > 1) messages.push(`多个同等信号候选（${best.length} 笔），请人工确认`);
  if (!leg.canAutoMatch && leg.automatic) messages.push("本笔已由所有者编辑，不会自动转换");
  for (const other of sameAmount) {
    const prefix = `${other.accountName} · ${other.date}`;
    const distance = dateDistance(leg, other);
    if (distance > 5) messages.push(`${prefix}：候选超出自动窗口（${distance} 天）`);
    else if (!other.connected) messages.push(`${prefix}：对方账户未连接或已停用`);
    else if (!signalStrength(leg, other)) messages.push(`${prefix}：双方缺少足够转账信号`);
    else if (!other.canAutoMatch) messages.push(`${prefix}：对方已由所有者编辑或不是自动入账，不会自动转换`);
    else if (
      best.length === 1 &&
      best[0].id === other.id &&
      strongestCandidates(other, automatic).length !== 1
    )
      messages.push(`${prefix}：对方有多个同等信号候选`);
  }
  return [...new Set(messages)];
}
export async function pendingTransfers(db: AppDb, ownerId: string, environment: string) {
  const { pool } = await loadMatchPool(db, ownerId, environment);
  return pendingTransfersFromPool(pool);
}
export function pendingTransfersFromPool(pool: MatchCandidate[]) {
  const all = amountIndex(pool);
  return pool
    .filter((leg) => leg.inScope && leg.row?.autoPostState !== "upstream" && leg.clearing)
    .map((leg) => ({
      ...publicLeg(leg),
      candidates: candidatesFor(leg, all(leg), 7).map(publicLeg),
      diagnostics: matchDiagnostics(leg, all(leg)),
    }));
}
export async function entryMatching(db: AppDb, ownerId: string, entryId: string) {
  const entry = await getEntry(db, ownerId, entryId);
  if (entry.status !== "confirmed")
    return { eligible: false, transferMatchId: null, candidates: [], diagnostics: [], accounts: [] };
  if (entry.transferMatchId)
    return {
      eligible: true,
      transferMatchId: entry.transferMatchId,
      candidates: [],
      diagnostics: [],
      accounts: [],
    };
  const { pool } = await loadMatchPool(db, ownerId);
  const leg = pool.find((item) => item.id === entryId);
  const all = amountIndex(pool);
  return {
    accounts: leg
      ? (
          await db
            .select()
            .from(accounts)
            .where(
              and(eq(accounts.ownerId, ownerId), eq(accounts.isSystem, false), eq(accounts.isActive, true)),
            )
        )
          .filter((account) =>
            pairType(leg, {
              accountId: account.id,
              accountType: account.type,
              currency: account.currency,
              amount: money(leg.amount).negated().toFixed(4),
            }),
          )
          .map(({ id, name }) => ({ id, name }))
      : [],
    eligible: Boolean(leg),
    transferMatchId: null,
    candidates: leg ? candidatesFor(leg, all(leg), 7).map(publicLeg) : [],
    diagnostics: leg ? matchDiagnostics(leg, all(leg)) : ["仅支持恰好一条真实账户分录的已确认流水"],
  };
}
const matchAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("match"), counterpartEntryId: z.uuid() }).strict(),
  z.object({ action: z.literal("unmatch") }).strict(),
  z.object({ action: z.literal("assign"), accountId: z.uuid() }).strict(),
]);
export async function resolveEntryMatching(db: AppDb, ownerId: string, entryId: string, input: unknown) {
  const action = matchAction.parse(input);
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const entry = await getEntry(tx, ownerId, entryId);
    invariant(entry.status === "confirmed", "仅能匹配已确认流水");
    if (action.action === "unmatch") {
      await unlinkLeg(tx, ownerId, entryId, true);
      return { transferMatchId: null };
    }
    invariant(!entry.transferMatchId, "请先取消现有匹配", 409);
    const { pool } = await loadMatchPool(tx, ownerId);
    const first = pool.find((leg) => leg.id === entryId);
    invariant(first, "候选不存在、已匹配或包含多条真实账户分录", 404);
    if (action.action === "assign") {
      const transferMatchId = await assignTransferAccount(tx, ownerId, first, action.accountId);
      await rememberTransferAssignment(tx, ownerId, first.legKey, action.accountId);
      return { transferMatchId };
    }
    const second = pool.find((leg) => leg.id === action.counterpartEntryId);
    invariant(first && second, "候选不存在、已匹配或包含多条真实账户分录", 404);
    return { transferMatchId: await matchCandidatePair(tx, ownerId, first, second, false) };
  });
}
