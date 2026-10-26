import { and, eq } from "drizzle-orm";
import { accounts, categories, merchantCategoryMemory } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { normalizeMerchant } from "./text";

export async function rememberedCategory(
  db: AppDb,
  ownerId: string,
  merchant: string,
  accountId: string | null,
  kind?: "expense" | "income",
) {
  if (!accountId) return null;
  const [record] = await db
    .select({ categoryId: categories.id })
    .from(merchantCategoryMemory)
    .innerJoin(
      accounts,
      and(
        eq(accounts.ownerId, ownerId),
        eq(accounts.id, accountId),
        eq(accounts.type, merchantCategoryMemory.accountType),
      ),
    )
    .innerJoin(
      categories,
      and(eq(categories.ownerId, ownerId), eq(categories.id, merchantCategoryMemory.categoryId)),
    )
    .where(
      and(
        eq(merchantCategoryMemory.ownerId, ownerId),
        eq(merchantCategoryMemory.merchant, normalizeMerchant(merchant)),
        eq(categories.isArchived, false),
        ...(kind ? [eq(categories.kind, kind)] : []),
      ),
    );
  return record?.categoryId ?? null;
}
