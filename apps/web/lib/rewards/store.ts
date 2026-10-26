import { and, eq, sql } from "drizzle-orm";
import { loyaltyAccounts, loyaltyPrograms } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { invariant } from "@/lib/ledger/errors";
export async function rewardsLock(db: AppDb, ownerId: string) {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`rewards:${ownerId}`}))`);
}
export async function requireProgram(db: AppDb, ownerId: string, id: string) {
  const [program] = await db
    .select()
    .from(loyaltyPrograms)
    .where(and(eq(loyaltyPrograms.ownerId, ownerId), eq(loyaltyPrograms.id, id)));
  invariant(program, "积分项目不存在", 404);
  return program;
}
export async function requireLoyaltyAccount(db: AppDb, ownerId: string, id: string, active = false) {
  const [account] = await db
    .select()
    .from(loyaltyAccounts)
    .where(and(eq(loyaltyAccounts.ownerId, ownerId), eq(loyaltyAccounts.id, id)));
  invariant(account, "积分账户不存在", 404);
  const program = await requireProgram(db, ownerId, account.programId);
  invariant(!active || (account.isActive && !program.isArchived), "积分账户或项目已停用");
  return account;
}
