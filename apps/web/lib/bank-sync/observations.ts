import { and, eq } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import { balanceSnapshots, snapshotFx, bankConnectionAccounts, users } from "@/db/schema";
import { money } from "@/lib/money";
import { listAccounts } from "@/lib/ledger/accounts";
import { invariant } from "@/lib/ledger/errors";
import { importLock } from "@/lib/imports/store";
import {
  createSnapshot,
  getSnapshot,
  listSnapshots,
  publishSnapshot,
  updateSnapshot,
} from "@/lib/snapshots/service";
import { findFxRate } from "@/lib/snapshots/fx";
import type { ItemInput } from "@/lib/snapshots/schemas";
import type { BankAccount, Holdings } from "./types";
export async function ownerSyncDate(db: AppDb, ownerId: string, now: Date) {
  const [user] = await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, ownerId));
  invariant(user, "用户不存在", 404);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: user.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
const inputItem = ({
  accountId,
  accountGroupId,
  balanceNative,
  currency,
  sourceRef,
  notes,
}: ItemInput): ItemInput => ({ accountId, accountGroupId, balanceNative, currency, sourceRef, notes });
export async function observeBalances(
  db: AppDb,
  ownerId: string,
  connectionId: string,
  mapped: (typeof bankConnectionAccounts.$inferSelect)[],
  balances: BankAccount[],
  holdings: Holdings | null,
  now: Date,
) {
  const date = await ownerSyncDate(db, ownerId, now);
  let items: ItemInput[] = [];
  for (const account of mapped.filter((row) => row.isEnabled && row.accountId && row.currency)) {
    const sourceRef = `plaid:${connectionId}:${account.plaidAccountId}:${now.toISOString()}`;
    if (account.type === "investment" && holdings && account.securityAccountId) {
      const held = holdings.holdings.filter((row) => row.accountId === account.plaidAccountId);
      if (held.some((row) => row.currency !== account.currency)) continue;
      for (const cash of [true, false])
        items.push({
          accountId: cash ? account.accountId! : account.securityAccountId,
          currency: account.currency!,
          balanceNative: held
            .filter((row) => row.cash === cash)
            .reduce((sum, row) => sum.plus(money(row.value)), money("0"))
            .toFixed(4),
          sourceRef,
        });
    } else if (["depository", "credit", "loan"].includes(account.type)) {
      const balance = balances.find((row) => row.id === account.plaidAccountId);
      if (balance?.current === null || !balance || balance.currency !== account.currency) continue;
      items.push({
        accountId: account.accountId!,
        currency: account.currency!,
        balanceNative: money(balance.current)
          .mul(account.type === "depository" ? "1" : "-1")
          .toFixed(4),
        sourceRef,
      });
    }
  }
  const missingCurrencies: string[] = [];
  if (!items.length) return { snapshotId: null, missingFx: false, missingCurrencies };
  const [existing] = await db
    .select()
    .from(balanceSnapshots)
    .where(
      and(
        eq(balanceSnapshots.ownerId, ownerId),
        eq(balanceSnapshots.source, "plaid"),
        eq(balanceSnapshots.snapshotDate, date),
      ),
    );
  const snapshot = existing
    ? await getSnapshot(db, ownerId, existing.id)
    : await createSnapshot(db, ownerId, {
        snapshotDate: date,
        label: `Plaid 同步 ${date}`,
        items,
        fx: [],
        notes: "同步账户余额观察；未由所有者核对为完整资产清单",
      });
  for (const currency of new Set(items.map((row) => row.currency))) {
    if (currency === snapshot.baseCurrency || snapshot.fx.some((rate) => rate.quoteCurrency === currency))
      continue;
    const rate = await findFxRate(db, ownerId, snapshot.baseCurrency, currency, date);
    if (!rate) missingCurrencies.push(currency);
    else if (snapshot.status === "published") {
      // Auto Plaid observations may gain a new currency on the same day. Append only;
      // never change a previously frozen rate or a saved reconciliation's inputs.
      await db.insert(snapshotFx).values({
        ownerId,
        snapshotId: snapshot.id,
        quoteCurrency: currency,
        rate: rate.rate,
        observedOn: rate.observedOn,
        source: rate.source,
        fxRateId: rate.id,
      });
    }
  }
  if (snapshot.status === "published")
    items = items.filter((item) => !missingCurrencies.includes(item.currency));
  if (existing && items.length)
    await updateSnapshot(db, ownerId, existing.id, {
      expectedRevision: existing.revision,
      items: [
        ...snapshot.items
          .filter((previous) => !items.some((item) => item.accountId === previous.accountId))
          .map(inputItem),
        ...items,
      ],
    });
  await db
    .update(balanceSnapshots)
    .set({ source: "plaid", isComplete: false })
    .where(and(eq(balanceSnapshots.ownerId, ownerId), eq(balanceSnapshots.id, snapshot.id)));
  if (!missingCurrencies.length) await publishSnapshot(db, ownerId, snapshot.id);
  await db
    .update(balanceSnapshots)
    .set({ isComplete: false })
    .where(and(eq(balanceSnapshots.ownerId, ownerId), eq(balanceSnapshots.id, snapshot.id)));
  return { snapshotId: snapshot.id, missingFx: missingCurrencies.length > 0, missingCurrencies };
}
export async function latestSyncedBalances(db: AppDb, ownerId: string) {
  const [snapshots, accounts, mappings] = await Promise.all([
    listSnapshots(db, ownerId),
    listAccounts(db, ownerId),
    db
      .select()
      .from(bankConnectionAccounts)
      .where(and(eq(bankConnectionAccounts.ownerId, ownerId), eq(bankConnectionAccounts.isEnabled, true))),
  ]);
  const result = [];
  for (const account of accounts.filter((row) => row.isActive)) {
    const mapping = mappings.find(
      (row) => row.accountId === account.id || row.securityAccountId === account.id,
    );
    if (!mapping) continue;
    const observed = snapshots
      .filter((row) => row.source === "plaid")
      .flatMap((snapshot) =>
        snapshot.items.filter((item) => item.accountId === account.id).map((item) => ({ snapshot, item })),
      )[0];
    // Cached balances remain visible when missing FX prevented snapshot inclusion.
    const hasCachedBalance =
      ["depository", "credit", "loan"].includes(mapping.type) &&
      mapping.lastBalanceCurrent !== null &&
      mapping.currency === account.currency;
    const balanceNative = hasCachedBalance
      ? money(mapping.lastBalanceCurrent!)
          .mul(mapping.type === "depository" ? "1" : "-1")
          .toFixed(4)
      : observed?.item.balanceNative;
    if (balanceNative === undefined) continue;
    result.push({
      accountId: account.id,
      name: account.name,
      currency: account.currency,
      balanceNative,
      syncedAt: hasCachedBalance ? mapping.lastBalanceAt : (observed?.item.createdAt ?? null),
      observedOn: observed?.snapshot.snapshotDate ?? null,
      sourceRef: observed?.item.sourceRef ?? `plaid:${mapping.connectionId}:${mapping.plaidAccountId}`,
      itemId: observed?.item.id ?? null,
    });
  }
  return result;
}
export async function createLatestSyncDraft(db: AppDb, ownerId: string, now = new Date()) {
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const [synced, accounts, snapshots, date] = await Promise.all([
      latestSyncedBalances(tx, ownerId),
      listAccounts(tx, ownerId),
      listSnapshots(tx, ownerId),
      ownerSyncDate(tx, ownerId, now),
    ]);
    invariant(synced.length, "尚无已映射账户的同步余额");
    const items: ItemInput[] = [];
    const missing: string[] = [];
    for (const account of accounts.filter((row) => row.isActive)) {
      const current = synced.find((row) => row.accountId === account.id);
      if (current) {
        items.push({
          accountId: account.id,
          currency: account.currency,
          balanceNative: current.balanceNative,
          sourceRef: current.sourceRef,
          notes: "Plaid 最新同步余额，请核对采集时间并确认",
        });
        continue;
      }
      const previous = snapshots
        .filter((snapshot) => snapshot.status === "published" && snapshot.snapshotDate <= date)
        .flatMap((snapshot) =>
          snapshot.items.filter((item) => item.accountId === account.id).map((item) => ({ snapshot, item })),
        )[0];
      if (previous)
        items.push({
          ...inputItem(previous.item),
          notes: `沿用 ${previous.snapshot.snapshotDate} 观察值，待确认`,
          sourceRef: `carried-forward:${previous.item.id}`,
        });
      else missing.push(account.name);
    }
    return createSnapshot(tx, ownerId, {
      snapshotDate: date,
      label: `余额核对草稿 ${date}`,
      items,
      fx: [],
      notes: `由最新同步余额预填。沿用观察与同步值均须核对；不会自动发布。${missing.length ? `缺少观察：${missing.join("、")}` : ""}`,
    });
  });
}
