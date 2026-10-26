import { importLock } from "@/lib/imports/store";
import { requireManualAccount } from "./balance-tracking";
import { lockOwnerStructure, validateGroupMember } from "@/lib/snapshots/groups";
import { and, eq, inArray } from "drizzle-orm";
import {
  accountCardSecrets,
  accountGroups,
  accounts,
  institutions,
  postings,
  snapshotItems,
} from "@/db/schema";
import type { AppDb } from "@/db/types";
import { accountSchema, accountPatchSchema, currencySchema, institutionSchema } from "./schemas";
import { accountLabels, cashLikeTypes, fundingTypes, systemTypes, type SystemType } from "./constants";
import { invariant } from "./errors";
import { auditLedger } from "./audit";
export async function listAccounts(db: AppDb, ownerId: string, includeSystem = false) {
  return db
    .select()
    .from(accounts)
    .where(and(eq(accounts.ownerId, ownerId), includeSystem ? undefined : eq(accounts.isSystem, false)))
    .orderBy(accounts.sortOrder, accounts.name);
}
export async function requireAccount(db: AppDb, ownerId: string, id: string) {
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.ownerId, ownerId), eq(accounts.id, id)));
  invariant(account, "账户不存在", 404);
  return account;
}
export async function listInstitutions(db: AppDb, ownerId: string) {
  return db.select().from(institutions).where(eq(institutions.ownerId, ownerId)).orderBy(institutions.name);
}
export async function createInstitution(db: AppDb, ownerId: string, input: unknown) {
  const values = institutionSchema.parse(input);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(institutions)
      .values({ ...values, ownerId })
      .returning();
    await auditLedger(tx, ownerId, "institution", row.id, "institution.create", values);
    return row;
  });
}
async function validateRelations(
  db: AppDb,
  ownerId: string,
  values: { institutionId?: string | null; accountGroupId?: string | null },
) {
  if (values.institutionId) {
    const rows = await db
      .select({ id: institutions.id })
      .from(institutions)
      .where(and(eq(institutions.ownerId, ownerId), eq(institutions.id, values.institutionId)));
    invariant(rows.length, "机构不存在", 404);
  }
  if (values.accountGroupId) {
    const rows = await db
      .select({ id: accountGroups.id })
      .from(accountGroups)
      .where(and(eq(accountGroups.ownerId, ownerId), eq(accountGroups.id, values.accountGroupId)));
    invariant(rows.length, "账户组不存在", 404);
  }
}
export async function createAccount(db: AppDb, ownerId: string, input: unknown) {
  const { institution, ...values } = accountSchema.parse(input);
  return db.transaction(async (tx) => {
    await lockOwnerStructure(tx, ownerId);
    if (institution) {
      invariant(!values.institutionId, "请选择已有机构或新增机构");
      values.institutionId = (await createInstitution(tx, ownerId, institution)).id;
    }
    await validateRelations(tx, ownerId, values);
    const cashLikeInclusion =
      values.cashLikeInclusion ?? (values.currency === "USD" && fundingTypes.includes(values.type));
    invariant(!cashLikeInclusion || cashLikeTypes.includes(values.type), "此账户类型不能计入现金类资产");
    invariant(
      !values.openedOn || !values.closedOn || values.closedOn >= values.openedOn,
      "关闭日期不能早于开户日期",
    );
    await validateGroupMember(tx, ownerId, {
      ...values,
      accountGroupId: values.accountGroupId ?? null,
      cashLikeInclusion,
      financialInclusion: values.financialInclusion ?? values.type !== "asset_prepaid",
    });
    const [row] = await tx
      .insert(accounts)
      .values({
        ...values,
        ownerId,
        cashLikeInclusion,
        financialInclusion: values.financialInclusion ?? values.type !== "asset_prepaid",
      })
      .returning();
    await auditLedger(tx, ownerId, "account", row.id, "account.create", values);
    return row;
  });
}
export async function updateAccount(db: AppDb, ownerId: string, id: string, input: unknown) {
  const { institution, ...values } = accountPatchSchema.parse(input);
  return db.transaction(async (tx) => {
    if (values.balanceReminderDays !== undefined) await importLock(tx, ownerId);
    await lockOwnerStructure(tx, ownerId);
    const [account] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.ownerId, ownerId), eq(accounts.id, id)))
      .for("update");
    invariant(account, "账户不存在", 404);
    if (values.balanceReminderDays !== undefined) await requireManualAccount(tx, ownerId, id);
    invariant(!account.isSystem, "系统科目不能手动修改");
    if (values.type && !["asset_cash", "liability_credit_card"].includes(values.type)) {
      const [card] = await tx
        .select({ id: accountCardSecrets.id })
        .from(accountCardSecrets)
        .where(and(eq(accountCardSecrets.ownerId, ownerId), eq(accountCardSecrets.accountId, id)))
        .limit(1);
      invariant(!card, "请先删除卡片信息，再更改账户类型");
    }
    if (
      (values.type && values.type !== account.type) ||
      (values.currency && values.currency !== account.currency)
    ) {
      const used = await tx
        .select({ id: postings.id })
        .from(postings)
        .where(and(eq(postings.ownerId, ownerId), eq(postings.accountId, id)))
        .limit(1);
      invariant(!used.length, "已有流水的账户不能修改类型或币种");
      const snapshots = await tx
        .select({ id: snapshotItems.id })
        .from(snapshotItems)
        .where(and(eq(snapshotItems.ownerId, ownerId), eq(snapshotItems.accountId, id)))
        .limit(1);
      invariant(!snapshots.length, "已有余额观察的账户不能修改类型或币种");
    }
    if (institution) {
      invariant(!values.institutionId, "请选择已有机构或新增机构");
      values.institutionId = (await createInstitution(tx, ownerId, institution)).id;
    }
    await validateRelations(tx, ownerId, values);
    const merged = { ...account, ...values };
    await validateGroupMember(tx, ownerId, merged);
    invariant(
      !merged.cashLikeInclusion || cashLikeTypes.includes(merged.type),
      "此账户类型不能计入现金类资产",
    );
    invariant(
      !merged.openedOn || !merged.closedOn || merged.closedOn >= merged.openedOn,
      "关闭日期不能早于开户日期",
    );
    const [row] = await tx
      .update(accounts)
      .set(values)
      .where(and(eq(accounts.ownerId, ownerId), eq(accounts.id, id)))
      .returning();
    await auditLedger(tx, ownerId, "account", id, "account.update", values);
    return row;
  });
}
export async function getSystemAccount(db: AppDb, ownerId: string, type: SystemType, currency: string) {
  invariant(systemTypes.includes(type), "系统科目类型无效");
  currencySchema.parse(currency);
  const condition = and(
    eq(accounts.ownerId, ownerId),
    eq(accounts.type, type),
    eq(accounts.currency, currency),
    eq(accounts.isSystem, true),
  );
  const [existing] = await db.select().from(accounts).where(condition);
  if (existing) {
    return existing;
  }
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(accounts)
      .values({
        ownerId,
        type,
        currency,
        name: `【系统】${accountLabels[type]} ${currency}`,
        isSystem: true,
        cashLikeInclusion: false,
        financialInclusion: false,
      })
      .onConflictDoNothing()
      .returning();
    if (created) {
      await auditLedger(tx, ownerId, "account", created.id, "account.system_create");
      return created;
    }
    const [row] = await tx.select().from(accounts).where(condition);
    invariant(row, "账户名称与保留的系统名称冲突", 409);
    return row;
  });
}
export async function loadPostingAccounts(db: AppDb, ownerId: string, ids: string[]) {
  return db
    .select()
    .from(accounts)
    .where(and(eq(accounts.ownerId, ownerId), inArray(accounts.id, [...new Set(ids)])))
    .orderBy(accounts.id)
    .for("share");
}
