import type { AppDb } from "@/db/types";
import { listAccounts } from "@/lib/ledger/accounts";
import { listSnapshots } from "@/lib/snapshots/service";
import { listAccountGroups } from "@/lib/snapshots/groups";
import { decimal, isStale } from "@/lib/money/fx";
import { accountInScope, groupInScope } from "@/lib/snapshots/scope";

type Account = Awaited<ReturnType<typeof listAccounts>>[number];
type Snapshot = Awaited<ReturnType<typeof listSnapshots>>[number];
type Group = Awaited<ReturnType<typeof listAccountGroups>>[number];
export function latestObservations(
  accounts: Account[],
  groups: Group[],
  all: Snapshot[],
  today: string,
  baseCurrency: string,
  staleDays: number,
  fxStaleDays: number,
) {
  const snapshots = all
    .filter((row) => row.status === "published" && row.snapshotDate <= today)
    .sort(
      (a, b) => b.snapshotDate.localeCompare(a.snapshotDate) || b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
  const active = accounts.filter((row) => row.isActive && !row.isSystem);
  const find = (accountId: string | null, groupId: string | null) =>
    snapshots.flatMap((snapshot) =>
      snapshot.items
        .filter((item) => (accountId ? item.accountId === accountId : item.accountGroupId === groupId))
        .map((item) => ({ snapshot, item })),
    )[0];
  type Observation = NonNullable<ReturnType<typeof find>>;
  const chosen: {
    key: string;
    name: string;
    members: string[];
    cashLike: boolean;
    financial: boolean;
    security: boolean;
    card: boolean;
    observation: Observation;
  }[] = [];
  const covered = new Set<string>();
  for (const group of groups) {
    const groupItem = find(null, group.id);
    const members = active.filter((row) => row.accountGroupId === group.id);
    // Prefer individual observations only when all members can replace the aggregate at or after its date.
    if (
      groupItem &&
      (!members.length ||
        !members.every((row) => {
          const item = find(row.id, null);
          return item && item.snapshot.snapshotDate >= groupItem.snapshot.snapshotDate;
        }))
    ) {
      chosen.push({
        key: `group:${group.id}`,
        name: `${group.name}（账户组）`,
        members: members.map((row) => row.id),
        cashLike: groupInScope(group, members, "cash_like"),
        financial: groupInScope(group, members, "financial"),
        security: group.isSecurity,
        card: members.length > 0 && members.every((row) => row.type === "liability_credit_card"),
        observation: groupItem,
      });
      members.forEach((row) => covered.add(row.id));
    }
  }
  for (const account of active) {
    if (covered.has(account.id)) continue;
    const observation = find(account.id, null);
    if (!observation) continue;
    chosen.push({
      key: account.id,
      name: account.name,
      members: [account.id],
      cashLike: accountInScope(account, "cash_like"),
      financial: accountInScope(account, "financial"),
      security: account.type === "asset_security",
      card: account.type === "liability_credit_card",
      observation,
    });
    covered.add(account.id);
  }
  const rows = chosen.map(({ observation: { snapshot, item }, ...unit }) => {
    // Frozen rates belong to this observation; cross-base conversion uses both frozen quotes.
    const nativeRate =
      item.currency === snapshot.baseCurrency
        ? { rate: "1", observedOn: snapshot.snapshotDate }
        : snapshot.fx.find((row) => row.quoteCurrency === item.currency);
    const baseRate =
      baseCurrency === snapshot.baseCurrency
        ? { rate: "1", observedOn: snapshot.snapshotDate }
        : snapshot.fx.find((row) => row.quoteCurrency === baseCurrency);
    const sameCurrency = item.currency === baseCurrency;
    const value = sameCurrency
      ? decimal(item.balanceNative)
      : nativeRate && baseRate
        ? decimal(item.balanceNative).div(decimal(nativeRate.rate)).mul(decimal(baseRate.rate))
        : null;
    return {
      ...unit,
      itemId: item.id,
      snapshotId: snapshot.id,
      source: snapshot.source,
      date: snapshot.snapshotDate,
      currency: item.currency,
      native: item.balanceNative,
      value: value?.toFixed(10) ?? null,
      stale: isStale(snapshot.snapshotDate, today, staleDays),
      missingFx: value === null,
      staleFx:
        !sameCurrency &&
        [nativeRate, baseRate].some((rate) => rate && isStale(rate.observedOn, today, fxStaleDays)),
    };
  });
  const missing = active
    .filter((row) => !covered.has(row.id))
    .map((row) => ({
      id: row.id,
      name: row.name,
      cashLike: row.cashLikeInclusion,
      security: row.type === "asset_security",
      card: row.type === "liability_credit_card",
      financial: accountInScope(row, "financial"),
    }));
  const total = (kind: "cashLike" | "financial" | "security" | "card") => {
    const included = rows.filter((row) => row[kind]);
    return {
      value:
        !included.length || included.some((row) => row.missingFx)
          ? null
          : included
              .reduce((sum, row) => sum.plus(decimal(row.value!)), decimal("0"))
              .mul(kind === "card" ? "-1" : "1")
              .toFixed(10),
      observed: included.length,
      missing: missing.filter((row) => row[kind]).map((row) => row.name),
      missingFx: included.filter((row) => row.missingFx).map((row) => row.name),
    };
  };
  return {
    rows,
    missing,
    cashLike: total("cashLike"),
    financial: total("financial"),
    investments: total("security"),
    cards: total("card"),
    baseCurrency,
    today,
  };
}
export async function observationOverview(
  db: AppDb,
  ownerId: string,
  today: string,
  baseCurrency: string,
  staleDays: number,
  fxStaleDays: number,
) {
  const [accounts, groups, snapshots] = await Promise.all([
    listAccounts(db, ownerId),
    listAccountGroups(db, ownerId),
    listSnapshots(db, ownerId),
  ]);
  return latestObservations(accounts, groups, snapshots, today, baseCurrency, staleDays, fxStaleDays);
}
