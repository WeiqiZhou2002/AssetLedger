import { and, eq } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import { importRows, journalEntries } from "@/db/schema";
import { buildPostings } from "@/lib/ledger/builders";
import { ensureDefaultCategories } from "@/lib/ledger/categories";
import { getEntry, replaceEntry } from "@/lib/ledger/entries";
import { loadPostingAccounts, requireAccount } from "@/lib/ledger/accounts";
import { isMerchantOfferRefund } from "@/lib/benefits/config";
import { auditLedger } from "@/lib/ledger/audit";
import { invariant } from "@/lib/ledger/errors";
import { normalizeMerchant } from "@/lib/imports/text";
import { money } from "@/lib/money";
import { categoryFor } from "./auto-category";
import { stampAutoEntry, type ImportRow } from "./auto-state";

type FallbackRow = Pick<
  ImportRow,
  "accountId" | "amount" | "transactionDate" | "postedDate" | "merchantNormalized" | "descriptionRaw"
>;
export async function fallbackInput(db: AppDb, ownerId: string, row: FallbackRow) {
  invariant(row.accountId && row.transactionDate, "收支缺少账户或日期");
  await ensureDefaultCategories(db, ownerId);
  const positive = money(row.amount).gt(0);
  const account = await requireAccount(db, ownerId, row.accountId);
  const type = isMerchantOfferRefund({
    amount: row.amount,
    accountType: account.type,
    description: `${row.descriptionRaw} ${row.merchantNormalized}`,
  })
    ? "refund"
    : positive
      ? "income"
      : "expense";
  const categoryId = await categoryFor(
    db,
    ownerId,
    { ...row, suggestedCategoryId: null },
    type === "income" ? "income" : "expense",
    null,
    false,
  );
  return {
    ...(await buildPostings(db, ownerId, type, {
      amount: money(row.amount).abs().toFixed(4),
      fromAccountId: positive ? null : row.accountId,
      toAccountId: positive ? row.accountId : null,
      categoryId,
      eventDate: row.transactionDate,
      postedDate: row.postedDate,
      merchant: row.merchantNormalized,
      description: row.descriptionRaw,
      status: "confirmed",
    })),
    source: "import" as const,
  };
}

// The caller unlinks first and holds the import/entry locks. Preserve dates and all evidence.
export async function fallbackClearingLeg(db: AppDb, ownerId: string, entryId: string, ownerAction: boolean) {
  const original = await getEntry(db, ownerId, entryId);
  const accounts = await loadPostingAccounts(
    db,
    ownerId,
    original.postings.map((line) => line.accountId),
  );
  const real = original.postings.filter((line) =>
    accounts.some((account) => account.id === line.accountId && !account.isSystem),
  );
  invariant(
    original.status === "confirmed" &&
      !original.transferMatchId &&
      real.length === 1 &&
      original.postings.length === 2 &&
      accounts.some((account) => account.type === "transfer_clearing"),
    "转账状态已改变",
    409,
  );
  const own = real[0];
  // Owner-made loan legs cannot be represented by income/expense under ledger rules.
  if (accounts.find((account) => account.id === own.accountId)?.type === "liability_loan") {
    await stampAutoEntry(db, ownerId, original.id, ownerAction);
    return original;
  }
  const input = await fallbackInput(db, ownerId, {
    accountId: own.accountId,
    amount: own.amount,
    transactionDate: original.eventDate,
    postedDate: original.postedDate,
    merchantNormalized: normalizeMerchant(original.merchant ?? ""),
    descriptionRaw: original.description ?? "",
  });
  const entry = await replaceEntry(
    db,
    ownerId,
    original.id,
    {
      ...input,
      source: original.source,
      merchant: original.merchant,
      description: original.description,
      notes: original.notes,
      externalReference: original.externalReference,
      isSummary: original.isSummary,
    },
    "未匹配转账改为收支",
  );
  await db
    .update(journalEntries)
    .set({
      providerAccountId: original.providerAccountId,
      providerTransactionId: original.providerTransactionId,
    })
    .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, entry.id)));
  await stampAutoEntry(db, ownerId, entry.id, ownerAction || original.autoPostOwnerEdited);
  await db
    .update(importRows)
    .set({
      journalEntryId: entry.id,
      suggestedEntryType: input.entryType,
      suggestedCategoryId: input.postings.find((line) => line.categoryId)?.categoryId ?? null,
    })
    .where(and(eq(importRows.ownerId, ownerId), eq(importRows.journalEntryId, original.id)));
  await db
    .update(importRows)
    .set({ linkedEntryId: entry.id })
    .where(and(eq(importRows.ownerId, ownerId), eq(importRows.linkedEntryId, original.id)));
  await auditLedger(db, ownerId, "journal_entry", entry.id, "transfer.fallback", {
    originalEntryId: original.id,
  });
  return entry;
}
