import { and, asc, desc, eq, sql } from "drizzle-orm";
import { balanceSnapshots, snapshotItems, snapshotFx, users } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { invariant } from "@/lib/ledger/errors";
import { auditLedger } from "@/lib/ledger/audit";
import { listAccounts } from "@/lib/ledger/accounts";
import { listAccountGroups, lockOwnerStructure } from "./groups";
import {
  snapshotSchema,
  snapshotPatchSchema,
  type ItemInput,
  type FrozenFxInput,
  type SnapshotInput,
} from "./schemas";
import { findFxRate } from "./fx";
const targetKey = (item: { accountId?: string | null; accountGroupId?: string | null }) =>
  item.accountId ? `a:${item.accountId}` : `g:${item.accountGroupId}`;
export async function getSnapshot(db: AppDb, ownerId: string, id: string) {
  const [row] = await db
    .select()
    .from(balanceSnapshots)
    .where(and(eq(balanceSnapshots.ownerId, ownerId), eq(balanceSnapshots.id, id)));
  invariant(row, "快照不存在", 404);
  const [history, fx] = await Promise.all([
    db
      .select()
      .from(snapshotItems)
      .where(and(eq(snapshotItems.ownerId, ownerId), eq(snapshotItems.snapshotId, id)))
      .orderBy(asc(snapshotItems.version)),
    db
      .select()
      .from(snapshotFx)
      .where(and(eq(snapshotFx.ownerId, ownerId), eq(snapshotFx.snapshotId, id)))
      .orderBy(snapshotFx.quoteCurrency),
  ]);
  return { ...row, items: history.filter((item) => item.isCurrent), history, fx };
}
export async function listSnapshots(db: AppDb, ownerId: string) {
  const rows = await db
    .select()
    .from(balanceSnapshots)
    .where(eq(balanceSnapshots.ownerId, ownerId))
    .orderBy(desc(balanceSnapshots.snapshotDate), desc(balanceSnapshots.createdAt));
  const [items, fx] = await Promise.all([
    db
      .select()
      .from(snapshotItems)
      .where(and(eq(snapshotItems.ownerId, ownerId), eq(snapshotItems.isCurrent, true))),
    db.select().from(snapshotFx).where(eq(snapshotFx.ownerId, ownerId)),
  ]);
  return rows.map((row) => ({
    ...row,
    items: items.filter((item) => item.snapshotId === row.id),
    fx: fx.filter((rate) => rate.snapshotId === row.id),
  }));
}
async function validateItems(db: AppDb, ownerId: string, items: ItemInput[]) {
  const [accountRows, groups] = await Promise.all([
    listAccounts(db, ownerId),
    listAccountGroups(db, ownerId),
  ]);
  invariant(new Set(items.map(targetKey)).size === items.length, "同一账户或组不可重复录入");
  const grouped = new Set(items.flatMap((item) => (item.accountGroupId ? [item.accountGroupId] : [])));
  for (const item of items) {
    const target = item.accountId
      ? accountRows.find((row) => row.id === item.accountId)
      : groups.find((row) => row.id === item.accountGroupId);
    invariant(target, "快照账户或组不存在", 404);
    invariant(target.currency === item.currency, "快照币种与账户不符");
    if (item.accountId) {
      const account = accountRows.find((row) => row.id === item.accountId)!;
      invariant(
        !account.accountGroupId || !grouped.has(account.accountGroupId),
        "同一快照不能同时包含组及其成员账户",
      );
    }
  }
  const accountsComplete = accountRows
    .filter((row) => row.isActive)
    .every((row) =>
      items.some(
        (item) =>
          item.accountId === row.id || (row.accountGroupId && item.accountGroupId === row.accountGroupId),
      ),
    );
  const unmappedGroups = groups.filter(
    (group) => !accountRows.some((account) => account.accountGroupId === group.id),
  );
  return accountsComplete && unmappedGroups.every((group) => grouped.has(group.id));
}
async function writeItems(db: AppDb, ownerId: string, snapshotId: string, values: ItemInput[]) {
  const current = await db
    .select()
    .from(snapshotItems)
    .where(and(eq(snapshotItems.ownerId, ownerId), eq(snapshotItems.snapshotId, snapshotId)));
  // Supersede atomically before inserting replacements; unchanged observations retain their IDs.
  const changed = values.filter((item) => {
    const previous = current.find((row) => row.isCurrent && targetKey(row) === targetKey(item));
    return (
      !previous ||
      previous.balanceNative !== sqlAmount(item.balanceNative) ||
      previous.currency !== item.currency ||
      previous.notes !== (item.notes ?? null) ||
      previous.sourceRef !== (item.sourceRef ?? null)
    );
  });
  const retained = new Set(values.filter((item) => !changed.includes(item)).map(targetKey));
  for (const previous of current.filter((row) => row.isCurrent && !retained.has(targetKey(row)))) {
    await db
      .update(snapshotItems)
      .set({ isCurrent: false, supersededAt: new Date() })
      .where(and(eq(snapshotItems.ownerId, ownerId), eq(snapshotItems.id, previous.id)));
  }
  for (const item of changed) {
    const version =
      Math.max(0, ...current.filter((row) => targetKey(row) === targetKey(item)).map((row) => row.version)) +
      1;
    await db.insert(snapshotItems).values({ ...item, ownerId, snapshotId, version });
  }
}
import { money } from "@/lib/money";
const sqlAmount = (value: string) => money(value).toFixed(4);
async function writeFx(
  db: AppDb,
  ownerId: string,
  snapshotId: string,
  date: string,
  base: string,
  values: FrozenFxInput[],
) {
  invariant(new Set(values.map((rate) => rate.quoteCurrency)).size === values.length, "汇率币种不可重复");
  for (const rate of values) {
    invariant(
      rate.quoteCurrency !== base && rate.observedOn <= date,
      "汇率日期不能晚于快照，基准币种无需录入",
    );
    // Catalog IDs are server-derived; manually supplied values stand on their own.
    invariant(!rate.fxRateId, "手工汇率不能指定目录 ID");
  }
  await db
    .delete(snapshotFx)
    .where(and(eq(snapshotFx.ownerId, ownerId), eq(snapshotFx.snapshotId, snapshotId)));
  if (values.length)
    await db.insert(snapshotFx).values(values.map((rate) => ({ ...rate, ownerId, snapshotId })));
}
export async function createSnapshot(db: AppDb, ownerId: string, input: SnapshotInput) {
  const values = snapshotSchema.parse(input);
  return db.transaction(async (tx) => {
    await lockOwnerStructure(tx, ownerId);
    const [owner] = await tx
      .select({ baseCurrency: users.baseCurrency })
      .from(users)
      .where(eq(users.id, ownerId));
    invariant(owner, "用户不存在", 404);
    const isComplete = await validateItems(tx, ownerId, values.items);
    const [row] = await tx
      .insert(balanceSnapshots)
      .values({
        ownerId,
        snapshotDate: values.snapshotDate,
        label: values.label,
        notes: values.notes,
        baseCurrency: owner.baseCurrency,
        isComplete,
        source: "manual",
      })
      .returning();
    await writeItems(tx, ownerId, row.id, values.items);
    await writeFx(tx, ownerId, row.id, row.snapshotDate, row.baseCurrency, values.fx);
    await auditLedger(tx, ownerId, "snapshot", row.id, "snapshot.create");
    return getSnapshot(tx, ownerId, row.id);
  });
}
export async function updateSnapshot(db: AppDb, ownerId: string, id: string, input: unknown) {
  const values = snapshotPatchSchema.parse(input);
  return db.transaction(async (tx) => {
    await lockOwnerStructure(tx, ownerId);
    const [row] = await tx
      .select()
      .from(balanceSnapshots)
      .where(and(eq(balanceSnapshots.ownerId, ownerId), eq(balanceSnapshots.id, id)))
      .for("update");
    invariant(row, "快照不存在", 404);
    invariant(row.revision === values.expectedRevision, "快照已更新，请刷新后重试", 409);
    invariant(
      row.status !== "published" ||
        (!values.fx && (!values.snapshotDate || values.snapshotDate === row.snapshotDate)),
      "发布后日期和汇率已冻结，只能更正观察值",
    );
    const isComplete = values.items ? await validateItems(tx, ownerId, values.items) : row.isComplete;
    if (values.items) await writeItems(tx, ownerId, id, values.items);
    if (values.fx)
      await writeFx(tx, ownerId, id, values.snapshotDate ?? row.snapshotDate, row.baseCurrency, values.fx);
    const oldFx = await tx
      .select()
      .from(snapshotFx)
      .where(and(eq(snapshotFx.ownerId, ownerId), eq(snapshotFx.snapshotId, id)));
    invariant(
      oldFx.every((rate) => rate.observedOn <= (values.snapshotDate ?? row.snapshotDate)),
      "汇率日期晚于新的快照日期",
    );
    if (row.status === "published" && values.items) {
      invariant(values.items.length > 0, "已发布快照必须保留至少一项观察");
      invariant(
        values.items.every(
          (item) =>
            item.currency === row.baseCurrency || oldFx.some((rate) => rate.quoteCurrency === item.currency),
        ),
        "该币种没有冻结汇率，请创建新快照",
      );
    }
    await tx
      .update(balanceSnapshots)
      .set({
        snapshotDate: values.snapshotDate,
        label: values.label,
        notes: values.notes,
        isComplete,
        revision: row.revision + 1,
      })
      .where(and(eq(balanceSnapshots.ownerId, ownerId), eq(balanceSnapshots.id, id)));
    await auditLedger(tx, ownerId, "snapshot", id, "snapshot.update", { revision: row.revision + 1 });
    return getSnapshot(tx, ownerId, id);
  });
}
export async function publishSnapshot(db: AppDb, ownerId: string, id: string) {
  return db.transaction(async (tx) => {
    await lockOwnerStructure(tx, ownerId);
    const snapshot = await getSnapshot(tx, ownerId, id);
    if (snapshot.status === "published") return snapshot;
    invariant(snapshot.items.length, "空快照不能发布");
    const isComplete = await validateItems(tx, ownerId, snapshot.items);
    for (const currency of new Set(snapshot.items.map((item) => item.currency))) {
      if (currency === snapshot.baseCurrency || snapshot.fx.some((rate) => rate.quoteCurrency === currency))
        continue;
      const rate = await findFxRate(tx, ownerId, snapshot.baseCurrency, currency, snapshot.snapshotDate);
      invariant(rate, `缺少 ${snapshot.baseCurrency}/${currency} 汇率`);
      await tx.insert(snapshotFx).values({
        ownerId,
        snapshotId: id,
        quoteCurrency: currency,
        rate: rate.rate,
        observedOn: rate.observedOn,
        source: rate.source,
        fxRateId: rate.id,
      });
    }
    await tx
      .update(balanceSnapshots)
      .set({
        status: "published",
        publishedAt: new Date(),
        isComplete,
        revision: sql`${balanceSnapshots.revision} + 1`,
      })
      .where(and(eq(balanceSnapshots.ownerId, ownerId), eq(balanceSnapshots.id, id)));
    await auditLedger(tx, ownerId, "snapshot", id, "snapshot.publish");
    return getSnapshot(tx, ownerId, id);
  });
}
