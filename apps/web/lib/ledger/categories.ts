import { and, eq, sql } from "drizzle-orm";
import { categories, postings, purchaseGroups } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { expenseCategoryNames, incomeCategoryNames } from "./constants";
import { categorySchema, categoryPatchSchema } from "./schemas";
import { invariant } from "./errors";
import { auditLedger } from "./audit";
export async function ensureDefaultCategories(db: AppDb, ownerId: string) {
  // Renaming or archiving defaults must not reseed them. The initial set is created atomically.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`categories:${ownerId}`}))`);
    const existing = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.ownerId, ownerId))
      .limit(1);
    if (existing.length) {
      return;
    }
    const values = [
      ...expenseCategoryNames.map((name, sortOrder) => ({ name, sortOrder, kind: "expense" as const })),
      ...incomeCategoryNames.map((name, sortOrder) => ({ name, sortOrder, kind: "income" as const })),
    ];
    const rows = await tx
      .insert(categories)
      .values(values.map((value) => ({ ...value, ownerId, isSystem: true })))
      .returning({ id: categories.id });
    for (const row of rows) {
      await auditLedger(tx, ownerId, "category", row.id, "category.seed");
    }
  });
}
export async function listCategories(db: AppDb, ownerId: string) {
  await ensureDefaultCategories(db, ownerId);
  return db
    .select()
    .from(categories)
    .where(eq(categories.ownerId, ownerId))
    .orderBy(categories.kind, categories.sortOrder, categories.name);
}
export async function requireCategory(
  db: AppDb,
  ownerId: string,
  id: string,
  kind?: "income" | "expense",
  allowArchived = false,
) {
  const [category] = await db
    .select()
    .from(categories)
    .where(and(eq(categories.ownerId, ownerId), eq(categories.id, id)))
    .for("share");
  invariant(category, "分类不存在", 404);
  invariant(!kind || category.kind === kind, "分类类型不匹配");
  invariant(allowArchived || !category.isArchived, "分类已归档");
  return category;
}
export async function createCategory(db: AppDb, ownerId: string, input: unknown) {
  const values = categorySchema.parse(input);
  await ensureDefaultCategories(db, ownerId);
  return db.transaction(async (tx) => {
    if (values.parentId) {
      await requireCategory(tx, ownerId, values.parentId, values.kind);
    }
    const [row] = await tx
      .insert(categories)
      .values({ ...values, ownerId })
      .returning();
    await auditLedger(tx, ownerId, "category", row.id, "category.create", values);
    return row;
  });
}
export async function updateCategory(db: AppDb, ownerId: string, id: string, input: unknown) {
  const values = categoryPatchSchema.parse(input);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`categories:${ownerId}`}))`);
    const [category] = await tx
      .select()
      .from(categories)
      .where(and(eq(categories.ownerId, ownerId), eq(categories.id, id)))
      .for("update");
    invariant(category, "分类不存在", 404);
    const kind = values.kind ?? category.kind;
    if (kind !== category.kind) {
      const used = await tx
        .select({ id: postings.id })
        .from(postings)
        .where(and(eq(postings.ownerId, ownerId), eq(postings.categoryId, id)))
        .limit(1);
      const groups = await tx
        .select({ id: purchaseGroups.id })
        .from(purchaseGroups)
        .where(and(eq(purchaseGroups.ownerId, ownerId), eq(purchaseGroups.categoryId, id)))
        .limit(1);
      invariant(!used.length && !groups.length, "已使用分类不能更改收支类型");
      const children = await tx
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.ownerId, ownerId), eq(categories.parentId, id)))
        .limit(1);
      invariant(!children.length, "有子分类时不能更改收支类型");
    }
    let parent = values.parentId === undefined ? category.parentId : values.parentId;
    const visited = new Set([id]);
    while (parent) {
      invariant(!visited.has(parent), "分类不能形成循环");
      visited.add(parent);
      const row = await requireCategory(tx, ownerId, parent, kind, true);
      parent = row.parentId;
    }
    const [row] = await tx
      .update(categories)
      .set(values)
      .where(and(eq(categories.ownerId, ownerId), eq(categories.id, id)))
      .returning();
    await auditLedger(tx, ownerId, "category", id, "category.update", values);
    return row;
  });
}

export async function deleteCategory(db: AppDb, ownerId: string, id: string) {
  return db.transaction(async (tx) => {
    const [category] = await tx
      .select()
      .from(categories)
      .where(and(eq(categories.ownerId, ownerId), eq(categories.id, id)))
      .for("update");
    invariant(category, "分类不存在", 404);
    invariant(!category.isSystem, "默认分类请使用归档，保留既有分类结构");
    const used = await tx
      .select({ id: postings.id })
      .from(postings)
      .where(and(eq(postings.ownerId, ownerId), eq(postings.categoryId, id)))
      .limit(1);
    const children = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.ownerId, ownerId), eq(categories.parentId, id)))
      .limit(1);
    const groups = await tx
      .select({ id: purchaseGroups.id })
      .from(purchaseGroups)
      .where(and(eq(purchaseGroups.ownerId, ownerId), eq(purchaseGroups.categoryId, id)))
      .limit(1);
    invariant(!used.length && !children.length && !groups.length, "已使用或包含子分类的分类请归档");
    await tx.delete(categories).where(and(eq(categories.ownerId, ownerId), eq(categories.id, id)));
    await auditLedger(tx, ownerId, "category", id, "category.delete");
  });
}
