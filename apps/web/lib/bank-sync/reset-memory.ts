import { sql } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import { merchantCategoryMemory } from "@/db/schema";
import { normalizeMerchant } from "@/lib/imports/text";
import type { ResetData } from "./reset-plan";

export async function rememberResetCategories(db: AppDb, ownerId: string, data: ResetData) {
  const candidates = new Map<string, typeof merchantCategoryMemory.$inferInsert>();
  for (const entry of data.removedEntries) {
    if (entry.status === "voided") continue;
    const merchant = normalizeMerchant(entry.merchant ?? "");
    if (!merchant) continue;
    const lines = data.lines.filter((line) => line.journalEntryId === entry.id);
    const categoryIds = [...new Set(lines.flatMap((line) => (line.categoryId ? [line.categoryId] : [])))];
    if (categoryIds.length !== 1) continue; // A split cannot be faithfully remembered as one category.
    const ownerEdited =
      entry.autoPostOwnerEdited ||
      (!entry.autoPosted && entry.source === "import") ||
      data.audits.some(
        (log) =>
          log.entityId === entry.id &&
          log.action === "entry.meta" &&
          Array.isArray(log.changes?.categories) &&
          log.changes.categories.length > 0,
      );
    for (const line of lines) {
      const account = data.accounts.find((row) => row.id === line.accountId);
      if (!account || account.isSystem) continue;
      const value: typeof merchantCategoryMemory.$inferInsert = {
        ownerId,
        merchant,
        accountType: account.type,
        categoryId: categoryIds[0],
        source: ownerEdited ? "owner_edited" : "auto",
        lastUsed: entry.updatedAt,
      };
      const key = `${account.type}:${merchant}`;
      const previous = candidates.get(key);
      if (
        !previous ||
        (value.source === "owner_edited" && previous.source !== "owner_edited") ||
        (value.source === previous.source && value.lastUsed >= previous.lastUsed)
      )
        candidates.set(key, value);
    }
  }
  for (const value of candidates.values()) {
    await db
      .insert(merchantCategoryMemory)
      .values(value)
      .onConflictDoUpdate({
        target: [
          merchantCategoryMemory.ownerId,
          merchantCategoryMemory.merchant,
          merchantCategoryMemory.accountType,
        ],
        set: { categoryId: value.categoryId, source: value.source, lastUsed: value.lastUsed },
        setWhere: sql`(${merchantCategoryMemory.source} = 'auto' AND ${value.source} = 'owner_edited') OR (${merchantCategoryMemory.source} = ${value.source} AND ${merchantCategoryMemory.lastUsed} <= ${value.lastUsed})`,
      });
  }
}
