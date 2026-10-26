import { loadMatchedTransfers, representativeEntry, transferPeerExists } from "@/lib/ledger/transfers";
import { and, count, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "@/db/types";
import { accounts, bankConnections, importRows, journalEntries } from "@/db/schema";
import { buildPostings } from "@/lib/ledger/builders";
import { getEntry, replaceEntry } from "@/lib/ledger/entries";
import { auditLedger } from "@/lib/ledger/audit";
import { invariant } from "@/lib/ledger/errors";
import { importLock } from "@/lib/imports/store";
import { money } from "@/lib/money";
import { applyAutoUpstream, nonPlaidDuplicates, postAutoRow } from "./auto-post";
import { stampAutoEntry, updateAutoRow } from "./auto-state";
import { restoreTransferChoices } from "./transfer-restore";
import { matchUniqueLegs, unmatchedLegs } from "./transfer-legs";
import { pendingTransfers, pendingTransfersFromPool, resolveEntryMatching } from "./matching";
import { loadMatchPool } from "./match-pool";
import { computeTransferSuggestions } from "./transfer-suggestions";
import type { PlaidConfig } from "./types";

export async function pendingCount(db: AppDb, ownerId: string, environment: PlaidConfig["PLAID_ENV"]) {
  const [loaded, rows] = await Promise.all([
    loadMatchPool(db, ownerId, environment),
    db
      .select({ count: count() })
      .from(importRows)
      .innerJoin(
        bankConnections,
        and(eq(bankConnections.id, importRows.bankConnectionId), eq(bankConnections.ownerId, ownerId)),
      )
      .where(
        and(
          eq(importRows.ownerId, ownerId),
          eq(bankConnections.environment, environment),
          inArray(importRows.autoPostState, ["duplicate", "upstream"]),
        ),
      ),
  ]);
  return (
    pendingTransfersFromPool(loaded.pool).length + computeTransferSuggestions(loaded).length + rows[0].count
  );
}

export async function pendingWorkbench(db: AppDb, ownerId: string, environment: PlaidConfig["PLAID_ENV"]) {
  const [loaded, rows, recent] = await Promise.all([
    loadMatchPool(db, ownerId, environment),
    db
      .select({
        row: importRows,
        accountName: accounts.name,
        connectionId: bankConnections.id,
        importFromDate: bankConnections.importFromDate,
      })
      .from(importRows)
      .innerJoin(
        bankConnections,
        and(eq(bankConnections.id, importRows.bankConnectionId), eq(bankConnections.ownerId, ownerId)),
      )
      .innerJoin(accounts, and(eq(accounts.id, importRows.accountId), eq(accounts.ownerId, ownerId)))
      .where(
        and(
          eq(importRows.ownerId, ownerId),
          eq(bankConnections.environment, environment),
          inArray(importRows.autoPostState, ["duplicate", "upstream"]),
        ),
      )
      .orderBy(importRows.createdAt),
    db
      .select({
        id: journalEntries.id,
        date: journalEntries.postedDate,
        eventDate: journalEntries.eventDate,
        type: journalEntries.entryType,
        merchant: journalEntries.merchant,
        amount: importRows.amount,
        currency: importRows.currency,
        accountName: accounts.name,
        transferMatchId: journalEntries.transferMatchId,
      })
      .from(journalEntries)
      .innerJoin(
        importRows,
        and(eq(importRows.journalEntryId, journalEntries.id), eq(importRows.ownerId, ownerId)),
      )
      .innerJoin(
        bankConnections,
        and(eq(bankConnections.id, importRows.bankConnectionId), eq(bankConnections.ownerId, ownerId)),
      )
      .innerJoin(accounts, and(eq(accounts.id, importRows.accountId), eq(accounts.ownerId, ownerId)))
      .where(
        and(
          eq(journalEntries.ownerId, ownerId),
          eq(journalEntries.autoPosted, true),
          or(
            representativeEntry(ownerId),
            // Keep an imported inflow when its outflow was assigned manually or belongs to another environment.
            sql`not ${transferPeerExists(
              ownerId,
              (peer) => sql`${peer.autoPosted} = true and exists (
              select 1 from ${importRows} inner join ${bankConnections}
              on ${bankConnections.id} = ${importRows.bankConnectionId} and ${bankConnections.ownerId} = ${ownerId}
              where ${importRows.ownerId} = ${ownerId} and ${importRows.journalEntryId} = ${peer.id}
              and ${bankConnections.environment} = ${environment}
            )`,
            )}`,
          ),
          eq(journalEntries.status, "confirmed"),
          eq(bankConnections.environment, environment),
        ),
      )
      .orderBy(desc(journalEntries.createdAt))
      .limit(20),
  ]);
  const matched = await loadMatchedTransfers(
    db,
    ownerId,
    recent.flatMap((entry) => (entry.transferMatchId ? [entry.transferMatchId] : [])),
  );
  const flagged = new Set(
    rows
      .filter(({ row }) => row.autoPostState === "upstream")
      .flatMap(({ row }) => (row.journalEntryId ? [row.journalEntryId] : [])),
  );
  const transfers = pendingTransfersFromPool(loaded.pool).filter((leg) => !flagged.has(leg.id));
  const suggestions = computeTransferSuggestions(loaded);
  const duplicateIds = [...new Set(rows.flatMap(({ row }) => row.duplicateCandidateEntryIds))];
  const duplicateEntries = duplicateIds.length
    ? await db
        .select({
          id: journalEntries.id,
          date: journalEntries.postedDate,
          eventDate: journalEntries.eventDate,
          merchant: journalEntries.merchant,
          description: journalEntries.description,
          status: journalEntries.status,
        })
        .from(journalEntries)
        .where(and(eq(journalEntries.ownerId, ownerId), inArray(journalEntries.id, duplicateIds)))
    : [];
  return {
    transfers,
    suggestions,
    rows: rows.map((item) => ({
      ...item,
      duplicateEntries: duplicateEntries.filter((entry) =>
        item.row.duplicateCandidateEntryIds.includes(entry.id),
      ),
    })),
    recent: recent.map((entry) => {
      const transfer = entry.transferMatchId ? (matched.get(entry.transferMatchId) ?? null) : null;
      return {
        ...entry,
        id: transfer?.from.entryId ?? entry.id,
        date: transfer?.from.date ?? entry.date,
        accountName: transfer?.from.accountName ?? entry.accountName,
        transfer,
      };
    }),
    count: transfers.length + rows.length + suggestions.length,
  };
}
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("match"), entryId: z.uuid(), counterpartEntryId: z.uuid() }).strict(),
  z.object({ action: z.literal("assign"), entryId: z.uuid(), accountId: z.uuid() }).strict(),
  z
    .object({
      action: z.literal("categorize"),
      entryId: z.uuid(),
      type: z.enum(["expense", "income", "loan_out", "loan_repayment", "refund"]),
      categoryId: z.uuid().optional(),
      accountId: z.uuid().optional(),
    })
    .strict(),
  z
    .object({
      action: z.enum(["keep_existing", "post_distinct"]),
      rowId: z.uuid(),
      entryId: z.uuid().optional(),
    })
    .strict(),
  z.object({ action: z.enum(["apply_upstream", "keep_local"]), rowId: z.uuid() }).strict(),
]);
export async function resolvePending(db: AppDb, ownerId: string, config: PlaidConfig, input: unknown) {
  invariant(config.PLAID_ENABLED === "true", "银行连接未启用", 404);
  const action = actionSchema.parse(input);
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    if (action.action === "match") {
      const visible = await pendingTransfers(tx, ownerId, config.PLAID_ENV);
      invariant(
        visible.some((leg) => leg.id === action.entryId),
        "待处理流水不存在",
        404,
      );
      return resolveEntryMatching(tx, ownerId, action.entryId, {
        action: "match",
        counterpartEntryId: action.counterpartEntryId,
      });
    }
    if (action.action === "assign" || action.action === "categorize") {
      const legs = await unmatchedLegs(tx, ownerId, config.PLAID_ENV);
      const leg = legs.find((row) => row.id === action.entryId);
      invariant(leg, "待匹配转账不存在或已经处理", 404);
      if (action.action === "assign") {
        return resolveEntryMatching(tx, ownerId, leg.id, { action: "assign", accountId: action.accountId });
      }
      const positive = money(leg.amount).gt(0);
      const original = await getEntry(tx, ownerId, leg.id);
      const entryInput = await buildPostings(tx, ownerId, action.type, {
        amount: money(leg.amount).abs().toFixed(4),
        fromAccountId: positive ? action.accountId : leg.accountId,
        toAccountId: positive ? leg.accountId : action.accountId,
        categoryId: action.categoryId,
        eventDate: leg.eventDate,
        postedDate: leg.date,
        merchant: original.merchant,
        description: original.description,
        status: "confirmed",
      });
      const effect = entryInput.postings
        .filter((line) => line.accountId === leg.accountId)
        .reduce((sum, line) => sum.plus(money(line.amount)), money("0"));
      invariant(effect.eq(money(leg.amount)), "所选收支类型与银行资金方向不符");
      const entry = await replaceEntry(
        tx,
        ownerId,
        leg.id,
        { ...entryInput, source: "import", externalReference: `plaid:${config.PLAID_ENV}` },
        "所有者归为收支",
      );
      await stampAutoEntry(tx, ownerId, entry.id, true);
      if (original.providerTransactionId)
        await tx
          .update(journalEntries)
          .set({
            providerAccountId: original.providerAccountId,
            providerTransactionId: original.providerTransactionId,
          })
          .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, entry.id)));
      await tx
        .update(importRows)
        .set({
          journalEntryId: entry.id,
          autoPostState: "posted",
          upstreamState: "none",
          reviewedAt: new Date(),
        })
        .where(and(eq(importRows.ownerId, ownerId), eq(importRows.journalEntryId, leg.id)));
      await auditLedger(tx, ownerId, "journal_entry", entry.id, "transfer.categorized", {
        originalEntryId: leg.id,
      });
      return { entryId: entry.id };
    }
    const [record] = await tx
      .select({ row: importRows, connection: bankConnections })
      .from(importRows)
      .innerJoin(
        bankConnections,
        and(eq(bankConnections.id, importRows.bankConnectionId), eq(bankConnections.ownerId, ownerId)),
      )
      .where(
        and(
          eq(importRows.ownerId, ownerId),
          eq(importRows.id, action.rowId),
          eq(bankConnections.environment, config.PLAID_ENV),
        ),
      );
    invariant(record, "待处理记录不存在", 404);
    const { row, connection } = record;
    if (action.action === "keep_existing" || action.action === "post_distinct") {
      if (row.autoPostState !== "duplicate") {
        invariant(row.journalEntryId || row.linkedEntryId, "记录不再是待处理重复候选", 409);
        return { entryId: row.journalEntryId ?? row.linkedEntryId };
      }
      if (action.action === "keep_existing") {
        const candidates = await nonPlaidDuplicates(tx, ownerId, row);
        const entryId = action.entryId ?? (candidates.length === 1 ? candidates[0] : null);
        invariant(entryId && candidates.includes(entryId), "请选择仍有效的重复候选流水");
        await updateAutoRow(tx, ownerId, row.id, {
          linkedEntryId: entryId,
          journalEntryId: null,
          autoPostState: "resolved",
          duplicateResolution: "duplicate",
          decision: "link_existing",
          upstreamState: "none",
          reviewedAt: new Date(),
        });
        await auditLedger(tx, ownerId, "import_row", row.id, "bank.keep_existing", { entryId });
        return { entryId };
      }
      invariant(row.upstreamState !== "removed", "上游已删除，不能重新入账");
      const entry = await postAutoRow(
        tx,
        ownerId,
        { ...row, linkedEntryId: null },
        { distinct: true, ownerEdited: true },
      );
      await auditLedger(tx, ownerId, "import_row", row.id, "bank.post_distinct", { entryId: entry?.id });
      return { entryId: entry?.id };
    }
    invariant(row.autoPostState === "upstream" && row.journalEntryId, "记录没有待处理的上游变更", 409);
    if (action.action === "keep_local") {
      await tx
        .update(journalEntries)
        .set({ autoPostOwnerEdited: true })
        .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, row.journalEntryId)));
      await updateAutoRow(tx, ownerId, row.id, {
        autoPostState: "resolved",
        upstreamState: "none",
        reviewedAt: new Date(),
      });
      await auditLedger(tx, ownerId, "import_row", row.id, "bank.keep_local");
    } else {
      invariant(
        (await getEntry(tx, ownerId, row.journalEntryId)).status === "confirmed",
        "流水已作废或替换，请保留本地处理结果",
      );
      await applyAutoUpstream(tx, ownerId, row, connection.importFromDate, true);
      await restoreTransferChoices(tx, ownerId, config.PLAID_ENV);
      await matchUniqueLegs(tx, ownerId, config.PLAID_ENV);
    }
    return { ok: true };
  });
}
export async function setAutoPost(
  db: AppDb,
  ownerId: string,
  id: string,
  config: PlaidConfig,
  input: unknown,
) {
  invariant(config.PLAID_ENABLED === "true", "银行连接未启用", 404);
  const { autoPost } = z.object({ autoPost: z.boolean() }).strict().parse(input);
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const [row] = await tx
      .update(bankConnections)
      .set({ autoPost })
      .where(
        and(
          eq(bankConnections.ownerId, ownerId),
          eq(bankConnections.id, id),
          eq(bankConnections.environment, config.PLAID_ENV),
          ne(bankConnections.status, "revoked"),
        ),
      )
      .returning({ id: bankConnections.id, autoPost: bankConnections.autoPost });
    invariant(row, "连接不存在或已撤销", 404);
    await auditLedger(tx, ownerId, "bank_connection", id, "bank.auto_post_setting", { autoPost });
    return row;
  });
}
