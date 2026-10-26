import type { AppDb } from "@/db/types";
import { listAccounts } from "@/lib/ledger/accounts";
import { accountPositions } from "@/lib/ledger/observed-balances";
import { listSnapshots } from "@/lib/snapshots/service";
import { listAccountGroups } from "@/lib/snapshots/groups";
import { listFxRates } from "@/lib/snapshots/fx";
import { latestObservations } from "./observations";
import { decimal, isStale } from "@/lib/money/fx";

type Account = Awaited<ReturnType<typeof listAccounts>>[number];
const sideOf = (account: Account) =>
  account.type.startsWith("liability_")
    ? ("liability" as const)
    : account.type.startsWith("asset_") &&
        (!["asset_receivable", "asset_prepaid"].includes(account.type) || account.financialInclusion)
      ? ("asset" as const)
      : null;
const bucketOf = (types: string[]) =>
  types.every((type) => ["asset_cash", "asset_brokerage_cash"].includes(type))
    ? "现金存款"
    : types.every((type) => type === "asset_security")
      ? "投资"
      : "其他";
type WealthRow = {
  id: string;
  name: string;
  accountIds: string[];
  side: "asset" | "liability";
  group: string;
  currency: string;
  native: string;
  value: string | null;
  date: string;
  source: string;
  stale: boolean;
  staleFx: boolean;
  missingFx: boolean;
  share: string | null;
};
export async function wealthOverview(
  db: AppDb,
  ownerId: string,
  today: string,
  baseCurrency: string,
  staleDays: number,
  fxStaleDays: number,
) {
  const [accounts, groups, snapshots, rates, positions] = await Promise.all([
    listAccounts(db, ownerId),
    listAccountGroups(db, ownerId),
    listSnapshots(db, ownerId),
    listFxRates(db, ownerId),
    accountPositions(db, ownerId, today),
  ]);
  const evaluate = (sourceSnapshots: typeof snapshots, asOf: string, fallback: boolean) => {
    const relevantAccounts = accounts.filter((account) => !account.openedOn || account.openedOn <= asOf);
    const latest = latestObservations(
      relevantAccounts.map((account) => ({ ...account, isActive: true })),
      groups,
      sourceSnapshots,
      asOf,
      baseCurrency,
      staleDays,
      fxStaleDays,
    );
    const rows: WealthRow[] = [];
    const excluded: { id: string; name: string; reason: string }[] = [];
    const covered = new Set<string>();
    for (const observation of latest.rows) {
      const members = relevantAccounts.filter((account) => observation.members.includes(account.id));
      const sides = new Set(members.map(sideOf));
      const side = members.length && sides.size === 1 ? sideOf(members[0]) : null;
      members.forEach((member) => covered.add(member.id));
      if (!side) {
        if (sides.size > 1 || !members.length)
          excluded.push({
            id: observation.key,
            name: observation.name,
            reason: "汇总观察无法区分资产与负债，请补录成员余额",
          });
        continue;
      }
      rows.push({
        id: observation.key,
        name: observation.name,
        accountIds: observation.members,
        side,
        group: side === "asset" ? bucketOf(members.map((member) => member.type)) : "负债",
        currency: observation.currency,
        native: side === "liability" ? decimal(observation.native).negated().toFixed(4) : observation.native,
        value:
          observation.value === null
            ? null
            : decimal(observation.value)
                .mul(side === "liability" ? "-1" : "1")
                .toFixed(10),
        date: observation.date,
        source: observation.source === "plaid" ? "Plaid 同步" : "快照",
        stale: observation.stale,
        staleFx: observation.staleFx,
        missingFx: observation.missingFx,
        share: null,
      });
    }
    for (const account of relevantAccounts.filter((account) => !covered.has(account.id) && sideOf(account))) {
      const side = sideOf(account)!;
      const position = positions.find((row) => row.account.id === account.id)!;
      if (!fallback || !position.hasConfirmedOpening || account.type === "asset_security") {
        excluded.push({
          id: account.id,
          name: account.name,
          reason: account.type === "asset_security" ? "未录入市值" : "未录入余额",
        });
        continue;
      }
      const rate =
        account.currency === baseCurrency
          ? { rate: "1", observedOn: today }
          : rates.find(
              (rate) =>
                rate.baseCurrency === baseCurrency &&
                rate.quoteCurrency === account.currency &&
                rate.observedOn <= today,
            );
      const native = decimal(position.ledger).mul(side === "liability" ? "-1" : "1");
      rows.push({
        id: account.id,
        name: account.name,
        accountIds: [account.id],
        side,
        group: side === "asset" ? bucketOf([account.type]) : "负债",
        currency: account.currency,
        native: native.toFixed(4),
        value: rate ? native.div(rate.rate).toFixed(10) : null,
        date: today,
        source: "账本推算（已有期初）",
        stale: false,
        staleFx: Boolean(rate && isStale(rate.observedOn, today, fxStaleDays)),
        missingFx: !rate,
        share: null,
      });
    }
    const known = rows.filter((row) => row.value !== null);
    const total = (side: "asset" | "liability") =>
      known.filter((row) => row.side === side).reduce((sum, row) => sum.plus(row.value!), decimal("0"));
    const assets = total("asset");
    const liabilities = total("liability");
    for (const row of rows) {
      const denominator = row.side === "asset" ? assets : liabilities;
      row.share =
        row.value !== null && !denominator.isZero()
          ? decimal(row.value).div(denominator).mul("100").toFixed(1)
          : null;
    }
    return {
      rows,
      excluded,
      assets: known.length ? assets.toFixed(10) : null,
      liabilities: known.length ? liabilities.toFixed(10) : null,
      netWorth: known.length ? assets.minus(liabilities).toFixed(10) : null,
      missingFx: rows.filter((row) => row.missingFx).map((row) => row.name),
      stale: rows.filter((row) => row.stale || row.staleFx).map((row) => row.name),
    };
  };
  const current = evaluate(snapshots, today, true);
  const history = snapshots
    .filter(
      (snapshot) => snapshot.status === "published" && snapshot.isComplete && snapshot.snapshotDate <= today,
    )
    .map((snapshot) => {
      const point = evaluate([snapshot], snapshot.snapshotDate, false);
      return {
        date: snapshot.snapshotDate,
        netWorth: point.excluded.length || point.missingFx.length ? null : point.netWorth,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  if (current.netWorth !== null) history.push({ date: `${today} · 最新余额`, netWorth: current.netWorth });
  return { ...current, history, today, baseCurrency };
}
