import { benefitConfig, detectBenefit } from "@/lib/benefits/config";
import { rememberedCategory } from "./category-memory";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import {
  accounts,
  bankConnectionAccounts,
  bankConnections,
  categories,
  importRows,
  journalEntries,
  postings,
  statements,
} from "@/db/schema";
import { money } from "@/lib/money";
import { daysBetween } from "@/lib/money/fx";
import type { EntryType } from "@/lib/ledger/constants";
import { normalizeMerchant, similarDescription } from "./text";
import { statementRows, requireStatement } from "./store";
import type { Direction, PairingSuggestion } from "./types";
const waitingForCounterpart = "等待对方账户同步或手动匹配";
export function suggestedType(direction: Direction): EntryType | null {
  if (direction === "charge") return "expense";
  if (direction === "payment") return "credit_card_payment";
  if (direction === "refund" || direction === "credit") return "refund";
  if (direction === "fee" || direction === "interest") return direction;
  if (direction === "transfer_in") return "income";
  if (direction === "transfer_out") return "transfer";
  return null;
}
export async function refreshSuggestions(db: AppDb, ownerId: string, statementId: string) {
  const statement = await requireStatement(db, ownerId, statementId);
  if (!statement.accountId && statement.source !== "plaid") return;
  const [ownRows, accountRows, allStatements, allRows, entries, lines, categoryRows, syncedAccounts] =
    await Promise.all([
      statementRows(db, ownerId, statementId),
      db.select().from(accounts).where(eq(accounts.ownerId, ownerId)),
      db.select().from(statements).where(eq(statements.ownerId, ownerId)),
      db.select().from(importRows).where(eq(importRows.ownerId, ownerId)),
      db
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.status, "confirmed")))
        .orderBy(desc(journalEntries.eventDate), desc(journalEntries.createdAt)),
      db.select().from(postings).where(eq(postings.ownerId, ownerId)),
      db
        .select()
        .from(categories)
        .where(and(eq(categories.ownerId, ownerId), eq(categories.isArchived, false))),
      db
        .select({ accountId: bankConnectionAccounts.accountId })
        .from(bankConnectionAccounts)
        .innerJoin(
          bankConnections,
          and(
            eq(bankConnections.id, bankConnectionAccounts.connectionId),
            eq(bankConnections.ownerId, ownerId),
          ),
        )
        .where(
          and(
            eq(bankConnectionAccounts.ownerId, ownerId),
            eq(bankConnectionAccounts.isEnabled, true),
            ne(bankConnections.status, "revoked"),
          ),
        ),
    ]);
  const syncedAccountIds = new Set(syncedAccounts.map((row) => row.accountId));
  const accountMap = new Map(accountRows.map((row) => [row.id, row]));
  const statementMap = new Map(allStatements.map((row) => [row.id, row]));

  const ownEvidence = new Set(ownRows.flatMap((row) => (row.journalEntryId ? [row.journalEntryId] : [])));
  const dateNear = (a: string | null, b: string | null, window: number) =>
    Boolean(a && b && Math.abs(daysBetween(a, b)) <= window);
  for (const row of ownRows) {
    if (row.journalEntryId || row.linkedEntryId) continue;
    const accountId = row.accountId ?? statement.accountId;
    const ownAccount = accountId ? accountMap.get(accountId) : null;
    if (!ownAccount) continue;
    const date = row.postedDate ?? row.transactionDate;
    const value = money(row.amount);
    const benefit = !row.reviewedAt
      ? detectBenefit({
          amount: row.amount,
          accountType: ownAccount.type,
          description: `${row.descriptionRaw} ${row.merchantNormalized}`,
          primary: typeof row.upstreamPayload?.primary === "string" ? row.upstreamPayload.primary : null,
        })
      : null;
    const candidateEntries = entries
      .filter((entry) => {
        if (ownEvidence.has(entry.id)) return false;
        if (
          row.providerTransactionId &&
          entry.providerAccountId === accountId &&
          entry.providerTransactionId === row.providerTransactionId
        )
          return true;
        const amount = lines
          .filter((line) => line.journalEntryId === entry.id && line.accountId === accountId)
          .reduce((sum, line) => sum.plus(money(line.amount)), money("0"));
        return (
          value.eq(amount) &&
          dateNear(date, entry.postedDate ?? entry.eventDate, 2) &&
          similarDescription(row.merchantNormalized, entry.merchant || entry.description || "")
        );
      })
      .map((entry) => entry.id);
    // Linked evidence can carry the bank-side provider ID of a paired payment.
    for (const other of allRows) {
      const effectiveId = other.journalEntryId ?? other.linkedEntryId;
      if (
        !effectiveId ||
        other.statementId === statementId ||
        (other.accountId ?? statementMap.get(other.statementId)?.accountId) !== accountId
      )
        continue;
      const providerMatch =
        row.providerTransactionId && row.providerTransactionId === other.providerTransactionId;
      if (
        (providerMatch ||
          (value.eq(money(other.amount)) &&
            dateNear(date, other.postedDate ?? other.transactionDate, 2) &&
            similarDescription(row.merchantNormalized, other.merchantNormalized))) &&
        !candidateEntries.includes(effectiveId)
      )
        candidateEntries.push(effectiveId);
    }
    const candidateRows = allRows
      .filter((other) => {
        if (
          other.statementId === statementId ||
          other.journalEntryId ||
          other.linkedEntryId ||
          other.decision === "exclude" ||
          other.duplicateResolution === "duplicate"
        )
          return false;
        if ((other.accountId ?? statementMap.get(other.statementId)?.accountId) !== accountId) return false;
        if (row.providerTransactionId && other.providerTransactionId === row.providerTransactionId)
          return true;
        return (
          value.eq(money(other.amount)) &&
          dateNear(date, other.postedDate ?? other.transactionDate, 2) &&
          similarDescription(row.merchantNormalized, other.merchantNormalized)
        );
      })
      .map((other) => other.id);
    const sameDay = ownRows.some(
      (other) =>
        other.id !== row.id &&
        (other.accountId ?? statement.accountId) === accountId &&
        date === (other.postedDate ?? other.transactionDate) &&
        value.eq(money(other.amount)),
    );
    const pairing: PairingSuggestion[] = [];
    const cardSide =
      !benefit && ownAccount.type === "liability_credit_card" && row.direction === "payment" && value.gt(0);
    const bankSide = ["asset_cash", "asset_brokerage_cash"].includes(ownAccount.type) && value.lt(0);
    if (cardSide || bankSide) {
      for (const other of allRows) {
        if (other.id === row.id || other.decision === "exclude") continue;
        const otherStatement = statementMap.get(other.statementId);
        const otherAccountId = other.accountId ?? otherStatement?.accountId;
        const otherAccount = otherAccountId ? accountMap.get(otherAccountId) : null;
        if (!otherAccount || otherAccount.currency !== row.currency) continue;
        const compatible = cardSide
          ? ["asset_cash", "asset_brokerage_cash"].includes(otherAccount.type)
          : otherAccount.type === "liability_credit_card" && other.direction === "payment";
        if (
          compatible &&
          value.plus(money(other.amount)).isZero() &&
          dateNear(date, other.postedDate ?? other.transactionDate, 3)
        ) {
          const entryId = other.journalEntryId ?? other.linkedEntryId;
          pairing.push({
            ...(entryId ? { entryId } : { rowId: other.id }),
            counterAccountId: otherAccount.id,
            kind: "credit_card_payment",
          });
        }
      }
      for (const entry of entries.filter(
        (entry) =>
          entry.entryType === "credit_card_payment" && dateNear(date, entry.postedDate ?? entry.eventDate, 3),
      )) {
        const ownLine = lines.find(
          (line) =>
            line.journalEntryId === entry.id && line.accountId === accountId && money(line.amount).eq(value),
        );
        const counter = lines.find(
          (line) => line.journalEntryId === entry.id && line.accountId !== accountId,
        );
        if (ownLine && counter && !pairing.some((item) => item.entryId === entry.id))
          pairing.push({
            entryId: entry.id,
            counterAccountId: counter.accountId,
            kind: "credit_card_payment",
          });
      }
    }
    let categoryId = row.suggestedCategoryId;
    if (!categoryId) {
      const prior = entries.find(
        (entry) =>
          normalizeMerchant(entry.merchant || "") === row.merchantNormalized &&
          lines.some(
            (line) =>
              line.journalEntryId === entry.id &&
              line.categoryId &&
              categoryRows.some((category) => category.id === line.categoryId),
          ),
      );
      categoryId = prior
        ? (lines.find((line) => line.journalEntryId === prior.id && line.categoryId)?.categoryId ?? null)
        : null;
    }
    if (!categoryId)
      categoryId = await rememberedCategory(
        db,
        ownerId,
        row.merchantNormalized,
        ownAccount.id,
        row.suggestedEntryType === "income" ? "income" : "expense",
      );
    if (benefit && !categoryId)
      categoryId =
        categoryRows.find(
          (category) =>
            category.kind === "expense" && benefitConfig[benefit].categories.includes(category.name),
        )?.id ??
        categoryRows.find((category) => category.kind === "expense" && category.name === "其他支出")?.id ??
        null;
    let counterAccountId = row.suggestedCounterAccountId;
    // A stored, unreviewed default is still only a suggestion. Keep explicit owner choices.
    const automaticCounter = !counterAccountId || !row.reviewedAt;
    if (!counterAccountId && cardSide) {
      const recent = entries.find(
        (entry) =>
          entry.entryType === "credit_card_payment" &&
          lines.some((line) => line.journalEntryId === entry.id && line.accountId === ownAccount.id),
      );
      const counter =
        recent &&
        lines.find((line) => {
          const account = accountMap.get(line.accountId);
          return (
            line.journalEntryId === recent.id &&
            money(line.amount).lt(0) &&
            account?.isActive &&
            account.currency === row.currency &&
            ["asset_cash", "asset_brokerage_cash"].includes(account.type)
          );
        });
      counterAccountId = counter ? counter.accountId : null;
    }
    const waitForCounterpart =
      automaticCounter &&
      counterAccountId !== null &&
      syncedAccountIds.has(counterAccountId) &&
      (cardSide || ["credit_card_payment", "transfer"].includes(row.suggestedEntryType ?? ""));
    if (waitForCounterpart) counterAccountId = null;
    await db
      .update(importRows)
      .set({
        ...(benefit ? { direction: "refund" as const, suggestedEntryType: "refund" as const } : {}),
        duplicateCandidateEntryIds: candidateEntries,
        duplicateCandidateRowIds: candidateRows,
        pairing,
        softNotes: [
          ...row.softNotes.filter(
            (note) =>
              note !== "同日同额两笔" && note !== waitingForCounterpart && !note.startsWith("权益报销建议："),
          ),
          ...(benefit ? [`权益报销建议：${benefitConfig[benefit].label}；批准时核对原消费及剩余额度`] : []),
          ...(sameDay ? ["同日同额两笔"] : []),
          ...(waitForCounterpart ? [waitingForCounterpart] : []),
        ],
        suggestedCategoryId: categoryId,
        suggestedCounterAccountId: benefit ? null : counterAccountId,
      })
      .where(and(eq(importRows.ownerId, ownerId), eq(importRows.id, row.id)));
  }
}
export async function refreshOwnerSuggestions(db: AppDb, ownerId: string) {
  const pending = await db
    .select({ id: statements.id })
    .from(statements)
    .where(
      and(eq(statements.ownerId, ownerId), inArray(statements.status, ["needs_review", "needs_mapping"])),
    );
  for (const statement of pending) await refreshSuggestions(db, ownerId, statement.id);
}
