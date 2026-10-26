import { and, eq, sql } from "drizzle-orm";
import { statements, importRows, importJobs } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { invariant } from "@/lib/ledger/errors";
export async function importLock(db: AppDb, ownerId: string) {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`imports:${ownerId}`}))`);
}
export async function requireStatement(db: AppDb, ownerId: string, id: string) {
  const [row] = await db
    .select()
    .from(statements)
    .where(and(eq(statements.ownerId, ownerId), eq(statements.id, id)));
  invariant(row, "账单不存在", 404);
  return row;
}
export async function statementRows(db: AppDb, ownerId: string, id: string) {
  return db
    .select()
    .from(importRows)
    .where(and(eq(importRows.ownerId, ownerId), eq(importRows.statementId, id)))
    .orderBy(importRows.rowIndex);
}
export async function assertEditable(db: AppDb, ownerId: string, id: string) {
  const statement = await requireStatement(db, ownerId, id);
  invariant(
    !["approved", "discarded", "parsing", "queued"].includes(statement.status),
    "账单正在处理或已经完成",
    409,
  );
  return statement;
}
export async function enqueue(
  db: AppDb,
  ownerId: string,
  statementId: string,
  kind: typeof importJobs.$inferInsert.kind,
  consent?: typeof importJobs.$inferInsert.consent,
) {
  const [job] = await db.insert(importJobs).values({ ownerId, statementId, kind, consent }).returning();
  await db
    .update(statements)
    .set({ status: "queued" })
    .where(and(eq(statements.ownerId, ownerId), eq(statements.id, statementId)));
  return job;
}
