import { and, desc, eq } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import { categories, journalEntries, postings } from "@/db/schema";
import { rememberedCategory } from "@/lib/imports/category-memory";
import { normalizeMerchant } from "@/lib/imports/text";
import { invariant } from "@/lib/ledger/errors";
import type { ImportRow } from "./auto-state";

export async function categoryFor(
  db: AppDb,
  ownerId: string,
  row: Pick<ImportRow, "merchantNormalized" | "accountId" | "suggestedCategoryId">,
  kind: "income" | "expense",
  fallback: string | null,
  useSuggestedCategory = true,
) {
  const available = await db
    .select()
    .from(categories)
    .where(and(eq(categories.ownerId, ownerId), eq(categories.kind, kind), eq(categories.isArchived, false)));
  const prior = await db
    .select({ entry: journalEntries, categoryId: postings.categoryId })
    .from(journalEntries)
    .innerJoin(postings, and(eq(postings.journalEntryId, journalEntries.id), eq(postings.ownerId, ownerId)))
    .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.status, "confirmed")))
    .orderBy(desc(journalEntries.eventDate), desc(journalEntries.createdAt));
  const history = prior.find(
    ({ entry, categoryId }) =>
      normalizeMerchant(entry.merchant ?? "") === row.merchantNormalized &&
      available.some((category) => category.id === categoryId),
  );
  const memory = history
    ? null
    : await rememberedCategory(db, ownerId, row.merchantNormalized, row.accountId, kind);
  const category =
    available.find((item) => item.id === history?.categoryId) ??
    available.find((item) => item.id === memory) ??
    available.find((item) => useSuggestedCategory && item.id === row.suggestedCategoryId) ??
    available.find((item) => item.name === fallback) ??
    available.find((item) => item.name === (kind === "income" ? "其他收入" : "其他支出"));
  invariant(category, `请恢复${kind === "income" ? "其他收入" : "其他支出"}分类后同步`);
  return category.id;
}
