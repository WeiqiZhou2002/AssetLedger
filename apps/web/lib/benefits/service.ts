import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { accounts, importRows, journalEntries, postings } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { getEntry, replaceEntry } from "@/lib/ledger/entries";
import { auditLedger } from "@/lib/ledger/audit";
import { invariant } from "@/lib/ledger/errors";
import { importLock } from "@/lib/imports/store";
import { stampAutoEntry, untouched } from "@/lib/bank-sync/auto-state";
import { unlinkLeg } from "@/lib/bank-sync/transfer-legs";
import { money } from "@/lib/money";
import { benefitFamilies, detectBenefit, type BenefitFamily } from "./config";
import { benefitInput } from "./input";

const editSchema = z
  .object({
    action: z.literal("set"),
    enabled: z.boolean(),
    family: z.enum(benefitFamilies).optional(),
  })
  .strict();
async function creditContext(db: AppDb, ownerId: string, id: string) {
  const entry = await getEntry(db, ownerId, id);
  invariant(entry.status !== "voided", "流水已作废", 409);
  const owned = await db.select().from(accounts).where(eq(accounts.ownerId, ownerId));
  const cards = entry.postings.filter(
    (line) =>
      money(line.amount).gt(0) &&
      owned.some((account) => account.id === line.accountId && account.type === "liability_credit_card"),
  );
  invariant(cards.length === 1, "请选择一笔信用卡贷记");
  return { entry, card: cards[0] };
}
export async function benefitDetail(db: AppDb, ownerId: string, id: string) {
  const { entry, card } = await creditContext(db, ownerId, id);
  const family =
    (entry.benefitFamily as BenefitFamily | null) ??
    detectBenefit({
      ...card,
      accountType: "liability_credit_card",
      description: `${entry.description ?? ""} ${entry.merchant ?? ""}`,
    }) ??
    "generic";
  return {
    enabled: entry.benefitCredit,
    family,
  };
}
// Automatic callers already hold the owner import lock. Manual calls acquire it here as well.
export async function editBenefit(db: AppDb, ownerId: string, id: string, input: unknown, automatic = false) {
  const action = editSchema.parse(input);
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    await tx
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, id)))
      .for("update");
    const { entry, card } = await creditContext(tx, ownerId, id);
    if (automatic)
      invariant(untouched(entry) && !entry.transferMatchId, "只重新识别未经编辑、未匹配的自动流水", 409);
    if (!action.enabled) {
      await tx
        .update(journalEntries)
        .set({
          benefitCredit: false,
          benefitFamily: null,
          autoPostOwnerEdited: (!automatic && entry.autoPosted) || entry.autoPostOwnerEdited,
          updatedAt: new Date(),
        })
        .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, id)));
      if (automatic) await stampAutoEntry(tx, ownerId, id);
      await auditLedger(tx, ownerId, "journal_entry", id, "benefit.unmark");
      return { entryId: id };
    }
    const family = action.family ?? "generic";
    const suggested = await benefitInput(tx, ownerId, {
      ...card,
      eventDate: entry.eventDate,
      postedDate: entry.postedDate,
      merchant: entry.merchant,
      description: entry.description,
      family,
    });
    if (entry.entryType !== "refund") {
      // Explicit conversion returns the peer to income/expense.
      if (entry.transferMatchId) await unlinkLeg(tx, ownerId, id, true, true);
      const replacement = await replaceEntry(
        tx,
        ownerId,
        id,
        {
          ...suggested,
          status: entry.status === "draft" ? "draft" : "confirmed",
          source: entry.source,
          notes: entry.notes,
          externalReference: entry.externalReference,
        },
        "改为权益报销",
      );
      await tx
        .update(journalEntries)
        .set({
          providerAccountId: entry.providerAccountId,
          providerTransactionId: entry.providerTransactionId,
        })
        .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, replacement.id)));
      await tx
        .update(importRows)
        .set({ journalEntryId: replacement.id })
        .where(and(eq(importRows.ownerId, ownerId), eq(importRows.journalEntryId, id)));
      await tx
        .update(importRows)
        .set({ linkedEntryId: replacement.id })
        .where(and(eq(importRows.ownerId, ownerId), eq(importRows.linkedEntryId, id)));
      if (entry.autoPosted) await stampAutoEntry(tx, ownerId, replacement.id, !automatic);
      await auditLedger(
        tx,
        ownerId,
        "journal_entry",
        replacement.id,
        automatic ? "auto_reclassified_benefit" : "benefit.convert",
        { originalEntryId: id },
      );
      return { entryId: replacement.id };
    }
    // Existing links are retained as historical data; new benefits never create them.
    const categoryId = suggested.postings.find((line) => line.categoryId)?.categoryId ?? null;
    await tx
      .update(journalEntries)
      .set({
        benefitCredit: true,
        benefitFamily: family,
        autoPostOwnerEdited: (!automatic && entry.autoPosted) || entry.autoPostOwnerEdited,
        updatedAt: new Date(),
      })
      .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, id)));
    if (categoryId) {
      for (const line of entry.postings.filter((line) => line.categoryId))
        await tx
          .update(postings)
          .set({ categoryId })
          .where(and(eq(postings.ownerId, ownerId), eq(postings.id, line.id)));
    }
    if (automatic) await stampAutoEntry(tx, ownerId, id);
    await auditLedger(
      tx,
      ownerId,
      "journal_entry",
      id,
      automatic ? "auto_reclassified_benefit" : "benefit.meta",
      { categoryId },
    );
    return { entryId: id };
  });
}
