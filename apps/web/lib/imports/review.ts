import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { importRows } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { requireAccount } from "@/lib/ledger/accounts";
import { categories } from "@/db/schema";
import { auditLedger } from "@/lib/ledger/audit";
import { invariant } from "@/lib/ledger/errors";
import { amountSchema } from "@/lib/money";
import { entryTypes } from "@/lib/ledger/constants";
import { dateSchema } from "@/lib/ledger/schemas";
import { directions } from "./types";
import { assertEditable, importLock, statementRows } from "./store";
import { normalizeMerchant, maskDigits } from "./text";
import { refreshOwnerSuggestions } from "./suggestions";
const rowPatchSchema = z
  .object({
    transactionDate: dateSchema.nullable().optional(),
    postedDate: dateSchema.nullable().optional(),
    descriptionRaw: z.string().max(2000).optional(),
    merchantNormalized: z.string().max(200).optional(),
    amount: amountSchema.optional(),
    direction: z.enum(directions).optional(),
    suggestedEntryType: z.enum(entryTypes).nullable().optional(),
    suggestedCategoryId: z.uuid().nullable().optional(),
    suggestedCounterAccountId: z.uuid().nullable().optional(),
    duplicateResolution: z.enum(["none", "distinct", "duplicate"]).optional(),
    decision: z.enum(["pending", "approve", "exclude", "link_existing"]).optional(),
    decisionPayload: z
      .object({
        linkEntryId: z.uuid().optional(),
        pairRowId: z.uuid().optional(),
        pairEntryId: z.uuid().optional(),
        notes: z.string().max(2000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export async function updateImportRows(db: AppDb, ownerId: string, statementId: string, input: unknown) {
  const { rowIds, changes } = z
    .object({ rowIds: z.array(z.uuid()).min(1).max(1000), changes: rowPatchSchema })
    .strict()
    .parse(input);
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    await assertEditable(tx, ownerId, statementId);
    const rows = (await statementRows(tx, ownerId, statementId)).filter((row) => rowIds.includes(row.id));
    invariant(rows.length === new Set(rowIds).size, "审核行不存在", 404);
    invariant(
      rows.every((row) => !row.journalEntryId && !row.linkedEntryId),
      "已入账行不能直接改写，请在流水中替换",
      409,
    );
    if (changes.suggestedCounterAccountId)
      await requireAccount(tx, ownerId, changes.suggestedCounterAccountId);
    if (changes.suggestedCategoryId) {
      const [category] = await tx
        .select()
        .from(categories)
        .where(and(eq(categories.ownerId, ownerId), eq(categories.id, changes.suggestedCategoryId)));
      invariant(category && !category.isArchived, "分类不存在或已归档");
    }
    await tx
      .update(importRows)
      .set({
        ...changes,
        ...(changes.descriptionRaw === undefined
          ? {}
          : { descriptionRaw: maskDigits(changes.descriptionRaw) }),
        ...(changes.merchantNormalized === undefined
          ? {}
          : { merchantNormalized: normalizeMerchant(changes.merchantNormalized) }),
        reviewedAt: new Date(),
      })
      .where(
        and(
          eq(importRows.ownerId, ownerId),
          eq(importRows.statementId, statementId),
          inArray(importRows.id, rowIds),
        ),
      );
    await auditLedger(tx, ownerId, "statement", statementId, "statement.review_rows", { rowIds });
    await refreshOwnerSuggestions(tx, ownerId);
    return statementRows(tx, ownerId, statementId);
  });
}
