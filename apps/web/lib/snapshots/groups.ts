import { and, eq, sql } from "drizzle-orm";
import { accountGroups, accounts, snapshotItems } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { invariant } from "@/lib/ledger/errors";
export async function lockOwnerStructure(db: AppDb, ownerId: string) {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`structure:${ownerId}`}))`);
}
export async function listAccountGroups(db: AppDb, ownerId: string) {
  return db
    .select()
    .from(accountGroups)
    .where(eq(accountGroups.ownerId, ownerId))
    .orderBy(accountGroups.name);
}
type Member = Pick<
  typeof accounts.$inferSelect,
  "type" | "currency" | "cashLikeInclusion" | "financialInclusion" | "accountGroupId"
>;
export async function validateGroupMember(db: AppDb, ownerId: string, member: Member & { id?: string }) {
  if (!member.accountGroupId) return;
  const [group] = await db
    .select()
    .from(accountGroups)
    .where(and(eq(accountGroups.ownerId, ownerId), eq(accountGroups.id, member.accountGroupId)));
  invariant(group, "账户组不存在", 404);
  invariant(
    group.currency === member.currency &&
      group.cashLikeInclusion === member.cashLikeInclusion &&
      group.financialInclusion === member.financialInclusion &&
      group.isSecurity === (member.type === "asset_security"),
    "组内账户必须使用相同币种、纳入开关和证券属性",
  );
  if (member.id) {
    const conflict = await db
      .select({ id: snapshotItems.id })
      .from(snapshotItems)
      .where(
        and(
          eq(snapshotItems.ownerId, ownerId),
          eq(snapshotItems.accountId, member.id),
          eq(snapshotItems.isCurrent, true),
          sql`exists (select 1 from snapshot_items g where g.owner_id = ${ownerId} and g.snapshot_id = ${snapshotItems.snapshotId} and g.account_group_id = ${member.accountGroupId} and g.is_current)`,
        ),
      )
      .limit(1);
    invariant(!conflict.length, "此分组会让已有快照同时包含组与成员，请先更正快照");
  }
}
