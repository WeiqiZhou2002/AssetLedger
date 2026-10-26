import { detectBenefit } from "@/lib/benefits/config";
import { benefitInput } from "@/lib/benefits/input";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "@/db/types";
import { importApprovals, importRows, journalEntries, statements } from "@/db/schema";
import { getEntry, createEntry } from "@/lib/ledger/entries";
import { buildPostings } from "@/lib/ledger/builders";
import { requireAccount } from "@/lib/ledger/accounts";
import { invariant, LedgerError } from "@/lib/ledger/errors";
import { auditLedger } from "@/lib/ledger/audit";
import { money } from "@/lib/money";
import { daysBetween } from "@/lib/money/fx";
import { importLock, requireStatement, statementRows } from "./store";
import { sha256 } from "./text";
import { refreshOwnerSuggestions } from "./suggestions";
import { ApprovalError, approvalProblems } from "./readiness";
type Row = typeof importRows.$inferSelect;
async function validateLink(
  db: AppDb,
  ownerId: string,
  row: Row,
  accountId: string,
  entryId: string,
  payment = false,
) {
  const entry = await getEntry(db, ownerId, entryId);
  invariant(entry.status === "confirmed", "只能关联已确认流水");
  invariant(!payment || entry.entryType === "credit_card_payment", "配对需要还信用卡流水");
  const amount = entry.postings
    .filter((line) => line.accountId === accountId && line.currency === row.currency)
    .reduce((sum, line) => sum.plus(money(line.amount)), money("0"));
  invariant(!amount.isZero() && amount.eq(money(row.amount)), "关联流水的账户、币种或金额不匹配");
  const date = row.postedDate ?? row.transactionDate;
  invariant(
    date && Math.abs(daysBetween(date, entry.postedDate ?? entry.eventDate)) <= (payment ? 3 : 2),
    "关联流水日期不匹配",
  );
  return entry;
}
async function providerEvidence(db: AppDb, ownerId: string, accountId: string, row: Row) {
  if (!row.providerTransactionId) return null;
  const [entry] = await db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.ownerId, ownerId),
        eq(journalEntries.providerAccountId, accountId),
        eq(journalEntries.providerTransactionId, row.providerTransactionId),
      ),
    );
  if (entry) return entry.id;
  const evidence = await db
    .select({ row: importRows })
    .from(importRows)
    .innerJoin(statements, and(eq(statements.id, importRows.statementId), eq(statements.ownerId, ownerId)))
    .where(
      and(
        eq(importRows.ownerId, ownerId),
        sql`coalesce(${importRows.accountId}, ${statements.accountId}) = ${accountId}`,
        eq(importRows.providerTransactionId, row.providerTransactionId),
      ),
    );
  return evidence.map(({ row: other }) => other.journalEntryId ?? other.linkedEntryId).find(Boolean) ?? null;
}
async function markLinked(db: AppDb, ownerId: string, row: Row, entryId: string) {
  await db
    .update(importRows)
    .set({ linkedEntryId: entryId, decision: "link_existing", reviewedAt: new Date() })
    .where(and(eq(importRows.ownerId, ownerId), eq(importRows.id, row.id)));
}
export async function updateApprovalStatus(
  db: AppDb,
  ownerId: string,
  statementId: string,
  retentionDays: number,
  now: Date,
) {
  const rows = await statementRows(db, ownerId, statementId);
  const finished =
    rows.length > 0 &&
    rows.every((row) => row.journalEntryId || row.linkedEntryId || row.decision === "exclude");
  await db
    .update(statements)
    .set({
      status: finished ? "approved" : "needs_review",
      deleteFileAfter: finished ? new Date(now.getTime() + retentionDays * 86400000) : null,
    })
    .where(and(eq(statements.ownerId, ownerId), eq(statements.id, statementId)));
}
export async function approveRows(
  db: AppDb,
  ownerId: string,
  statementId: string,
  input: unknown,
  retentionDays = 30,
  now = new Date(),
) {
  const request = z
    .object({ rowIds: z.array(z.uuid()).min(1).max(1000), idempotencyKey: z.string().min(8).max(200) })
    .strict()
    .parse(input);
  const ids = [...new Set(request.rowIds)].sort();
  const hash = sha256(JSON.stringify(ids));
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const statement = await requireStatement(tx, ownerId, statementId);
    const [prior] = await tx
      .select()
      .from(importApprovals)
      .where(
        and(
          eq(importApprovals.ownerId, ownerId),
          eq(importApprovals.statementId, statementId),
          eq(importApprovals.idempotencyKey, request.idempotencyKey),
        ),
      );
    if (prior) {
      invariant(prior.rowSetHash === hash, "幂等键已用于不同的审核行", 409);
      return prior.result;
    }
    invariant(
      ["needs_review", "approved"].includes(statement.status) &&
        (statement.accountId || statement.source === "plaid"),
      "请先完成账户匹配和解析",
    );
    const selected = (await statementRows(tx, ownerId, statementId)).filter((row) => ids.includes(row.id));
    invariant(selected.length === ids.length, "审核行不存在", 404);
    const problems = selected
      .map((row) => ({ rowId: row.id, rowIndex: row.rowIndex, reasons: approvalProblems(row) }))
      .filter((row) => row.reasons.length);
    if (problems.length) throw new ApprovalError(problems);
    const result: { rowId: string; entryId: string }[] = [];
    const touched = new Set([statementId]);
    for (const selectedRow of selected) {
      try {
        const [row] = await tx
          .select()
          .from(importRows)
          .where(and(eq(importRows.ownerId, ownerId), eq(importRows.id, selectedRow.id)))
          .for("update");
        const existing = row.journalEntryId ?? row.linkedEntryId;
        if (existing) {
          result.push({ rowId: row.id, entryId: existing });
          continue;
        }
        if (row.decision === "exclude") continue;
        const accountId = row.accountId ?? statement.accountId;
        invariant(accountId, "缺少账本账户映射");
        const account = await requireAccount(tx, ownerId, accountId);
        invariant(account.isActive && !account.isSystem, "账单账户未启用");
        invariant(row.upstreamState !== "removed", "上游已删除，请排除此行");
        invariant(["approve", "link_existing"].includes(row.decision), "请明确批准或关联每一行");
        invariant(row.currency === account.currency && !money(row.amount).isZero(), "行币种或零金额无效");
        const knownProvider = await providerEvidence(tx, ownerId, account.id, row);
        const requestedLink = row.decisionPayload.linkEntryId ?? row.decisionPayload.pairEntryId;
        if (row.decision === "link_existing" || requestedLink) {
          invariant(requestedLink, "请选择要关联的已有流水");
          invariant(!knownProvider || knownProvider === requestedLink, "银行交易编号已属于另一笔流水", 409);
          const entry = await validateLink(
            tx,
            ownerId,
            row,
            account.id,
            requestedLink,
            Boolean(row.decisionPayload.pairEntryId),
          );
          await markLinked(tx, ownerId, row, entry.id);
          result.push({ rowId: row.id, entryId: entry.id });
          continue;
        }
        invariant(!knownProvider, "银行交易编号已入账，请关联已有流水", 409);
        invariant(row.duplicateResolution !== "duplicate", "重复行需要排除或关联，不能新建流水");
        let pair: Row | null = null;
        let counterId = row.suggestedCounterAccountId;
        let type = row.suggestedEntryType;
        if (row.decisionPayload.pairRowId) {
          const [other] = await tx
            .select()
            .from(importRows)
            .where(and(eq(importRows.ownerId, ownerId), eq(importRows.id, row.decisionPayload.pairRowId)))
            .for("update");
          invariant(other && other.id !== row.id, "配对行不存在", 404);
          const otherStatement = await requireStatement(tx, ownerId, other.statementId);
          const otherAccountId = other.accountId ?? otherStatement.accountId;
          invariant(
            otherAccountId && other.decision !== "exclude" && otherStatement.status !== "discarded",
            "配对行不可用",
          );
          const otherAccount = await requireAccount(tx, ownerId, otherAccountId);
          invariant(
            other.currency === row.currency && money(other.amount).plus(money(row.amount)).isZero(),
            "配对币种或金额不匹配",
          );
          const ownDate = row.postedDate ?? row.transactionDate;
          const otherDate = other.postedDate ?? other.transactionDate;
          invariant(
            ownDate && otherDate && Math.abs(daysBetween(ownDate, otherDate)) <= 3,
            "配对日期须相差不超过三天",
          );
          const isCard =
            account.type === "liability_credit_card" &&
            row.direction === "payment" &&
            money(row.amount).gt(0);
          const otherIsCard =
            otherAccount.type === "liability_credit_card" &&
            other.direction === "payment" &&
            money(other.amount).gt(0);
          invariant(
            isCard
              ? ["asset_cash", "asset_brokerage_cash"].includes(otherAccount.type)
              : otherIsCard && ["asset_cash", "asset_brokerage_cash"].includes(account.type),
            "只支持银行扣款与信用卡还款配对",
          );
          if (other.journalEntryId || other.linkedEntryId) {
            const entry = await validateLink(
              tx,
              ownerId,
              row,
              account.id,
              (other.journalEntryId ?? other.linkedEntryId)!,
              true,
            );
            await markLinked(tx, ownerId, row, entry.id);
            result.push({ rowId: row.id, entryId: entry.id });
            continue;
          }
          invariant(
            !(await providerEvidence(tx, ownerId, otherAccount.id, other)),
            "配对行的银行编号已入账，请关联已有流水",
            409,
          );
          pair = other;
          counterId = otherAccount.id;
          type = "credit_card_payment";
        }
        invariant(type && row.transactionDate, "请补齐交易日期和类型");
        const positive = money(row.amount).gt(0);
        const benefit =
          type === "refund"
            ? detectBenefit({
                amount: row.amount,
                accountType: account.type,
                description: `${row.descriptionRaw} ${row.merchantNormalized}`,
                primary:
                  typeof row.upstreamPayload?.primary === "string" ? row.upstreamPayload.primary : null,
              })
            : null;
        const entryInput = benefit
          ? await benefitInput(tx, ownerId, {
              accountId: account.id,
              amount: row.amount,
              currency: row.currency,
              eventDate: row.transactionDate,
              postedDate: row.postedDate,
              description: row.descriptionRaw,
              merchant: row.merchantNormalized,
              family: benefit,
            })
          : await buildPostings(tx, ownerId, type, {
              amount: ["opening_balance", "balance_adjustment"].includes(type)
                ? row.amount
                : money(row.amount).abs().toFixed(4),
              fromAccountId: positive ? counterId : account.id,
              toAccountId:
                positive || ["opening_balance", "balance_adjustment"].includes(type) ? account.id : counterId,
              categoryId: row.suggestedCategoryId,
              eventDate: row.transactionDate,
              postedDate: row.postedDate,
              merchant: row.merchantNormalized,
              description: row.descriptionRaw,
              notes: row.decisionPayload.notes,
              interestDirection: positive ? "income" : "expense",
              status: "confirmed",
            });
        const effect = entryInput.postings
          .filter((line) => line.accountId === account.id)
          .reduce((sum, line) => sum.plus(money(line.amount)), money("0"));
        invariant(effect.eq(money(row.amount)), "交易类型与账单行的借贷方向不匹配");
        const entry = await createEntry(tx, ownerId, { ...entryInput, source: "import" });
        if (row.providerTransactionId)
          await tx
            .update(journalEntries)
            .set({ providerAccountId: account.id, providerTransactionId: row.providerTransactionId })
            .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, entry.id)));
        await tx
          .update(importRows)
          .set({ journalEntryId: entry.id, reviewedAt: now })
          .where(and(eq(importRows.ownerId, ownerId), eq(importRows.id, row.id)));
        if (pair) {
          await markLinked(tx, ownerId, pair, entry.id);
          touched.add(pair.statementId);
        }
        result.push({ rowId: row.id, entryId: entry.id });
      } catch (error) {
        if (error instanceof LedgerError || error instanceof z.ZodError)
          throw new ApprovalError([
            {
              rowId: selectedRow.id,
              rowIndex: selectedRow.rowIndex,
              reasons: [error instanceof LedgerError ? error.message : "请检查日期、金额和必填项"],
            },
          ]);
        throw error;
      }
    }
    for (const id of touched) await updateApprovalStatus(tx, ownerId, id, retentionDays, now);
    await tx
      .insert(importApprovals)
      .values({ ownerId, statementId, idempotencyKey: request.idempotencyKey, rowSetHash: hash, result });
    await auditLedger(tx, ownerId, "statement", statementId, "statement.approve", { rowIds: ids });
    await refreshOwnerSuggestions(tx, ownerId);
    return result;
  });
}
