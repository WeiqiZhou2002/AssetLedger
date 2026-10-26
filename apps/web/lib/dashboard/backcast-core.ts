import { decimal } from "@/lib/money/fx";
import { shiftDate } from "@/lib/bank-sync/date-range";
import { dateSchema } from "@/lib/ledger/schemas";
import { invariant } from "@/lib/ledger/errors";

export type BackcastObservation = {
  date: string;
  balance: string;
  itemId: string;
  frozenRate: string | null;
};
export type BackcastAccount = {
  id: string;
  name: string;
  currency: string;
  side: "asset" | "liability";
  security: boolean;
  observationOnly?: boolean;
  openedOn: string | null;
  plaidCoverageStart: string | null;
  observations: BackcastObservation[];
  flows: { date: string; amount: string; entryId: string; opening: boolean }[];
};
export type BackcastInput = {
  from: string;
  to: string;
  baseCurrency: string;
  accounts: BackcastAccount[];
  rates: { currency: string; date: string; rate: string; id: string; createdAt?: string }[];
  observations: { date: string; netWorth: string; snapshotId: string }[];
  plaidAvailability?: { earliest: string; latest: string } | null;
};
export type CoverageGap = { id: string; name: string; reason: string };
export type BackcastDay = {
  date: string;
  assets: string | null;
  liabilities: string | null;
  netWorth: string | null;
  complete: boolean;
  estimated: boolean;
  estimatedAccounts: { id: string; name: string; coverageStart: string }[];
  uncovered: CoverageGap[];
  fxFallbackAccounts: { id: string; name: string }[];
  observations: BackcastInput["observations"];
};

// Cumulative sums allow both rollback and roll-forward without rounding each day's movements.
function cumulative(flows: BackcastAccount["flows"]) {
  let sum = decimal("0");
  const points = [...flows]
    .sort((a, b) => a.date.localeCompare(b.date) || a.entryId.localeCompare(b.entryId))
    .map((flow) => ({ date: flow.date, sum: (sum = sum.plus(flow.amount)) }));
  return (date: string) => {
    let left = 0;
    let right = points.length;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (points[middle].date <= date) left = middle + 1;
      else right = middle;
    }
    return left ? points[left - 1].sum : decimal("0");
  };
}
function prepareAccount(account: BackcastAccount, to: string) {
  const flows = account.flows.filter((flow) => flow.date <= to);
  const sumThrough = cumulative(flows);
  const openings = flows.filter((flow) => flow.opening).toSorted((a, b) => a.date.localeCompare(b.date));
  const openingObservations = account.observationOnly
    ? openings.map((flow) => ({
        date: flow.date,
        balance: sumThrough(flow.date).toFixed(4),
        itemId: flow.entryId,
        frozenRate: null,
      }))
    : [];
  // Loader supplies newest revision first on the same day; sorting is stable.
  const observations = [...account.observations, ...openingObservations]
    .filter((row) => row.date <= to)
    .toSorted((a, b) => b.date.localeCompare(a.date));
  const firstOpening = openings[0]?.date;
  const firstObserved = observations.at(-1)?.date;
  const carry = account.security || account.observationOnly;
  const naturalStart =
    [firstOpening, firstObserved].filter((value): value is string => Boolean(value)).sort()[0] ?? null;
  let coverageStart = carry ? (firstObserved ?? null) : (account.plaidCoverageStart ?? naturalStart);
  if (!observations.length && firstOpening && coverageStart && firstOpening > coverageStart)
    coverageStart = firstOpening;
  const noAnchor = carry ? !observations.length : !observations.length && !firstOpening;
  return { ...account, observations, cumulative: sumThrough, carry, coverageStart, noAnchor };
}

export function buildBackcast(input: BackcastInput) {
  dateSchema.parse(input.from);
  dateSchema.parse(input.to);
  invariant(input.from <= input.to, "回溯起点不能晚于结束日期");
  const rates = [...input.rates]
    .filter((rate) => rate.date <= input.to)
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        (b.createdAt ?? "").localeCompare(a.createdAt ?? "") ||
        b.id.localeCompare(a.id),
    );
  const excluded: CoverageGap[] = [];
  const prepared = [...input.accounts]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((account) => prepareAccount(account, input.to))
    .filter((account) => {
      let reason: string | null = null;
      if (account.noAnchor || !account.coverageStart)
        reason = account.security ? "未录入市值观察" : "缺少余额观察和已确认期初";
      else if (
        account.currency !== input.baseCurrency &&
        !rates.some((rate) => rate.currency === account.currency) &&
        !account.observations.some((row) => row.frozenRate)
      )
        reason = "没有可用汇率";
      if (reason) excluded.push({ id: account.id, name: account.name, reason });
      return !reason;
    });
  const days: BackcastDay[] = [];
  for (let date = input.from; date <= input.to; date = shiftDate(date, 1)) {
    let assets = decimal("0");
    let liabilities = decimal("0");
    const estimatedAccounts: BackcastDay["estimatedAccounts"] = [];
    const fxFallbackAccounts: BackcastDay["fxFallbackAccounts"] = [];
    for (const account of prepared) {
      if (account.openedOn && date < account.openedOn) continue;
      const balanceDate = date < account.coverageStart! ? account.coverageStart! : date;
      if (date < account.coverageStart!)
        estimatedAccounts.push({ id: account.id, name: account.name, coverageStart: account.coverageStart! });
      const anchor = account.carry
        ? (account.observations.find((row) => row.date <= balanceDate) ?? account.observations.at(-1))
        : account.observations[0];
      const native = anchor
        ? account.carry
          ? decimal(anchor.balance)
          : decimal(anchor.balance)
              .plus(account.cumulative(balanceDate))
              .minus(account.cumulative(anchor.date))
        : account.cumulative(balanceDate);
      const currencyRates = rates.filter((row) => row.currency === account.currency);
      const catalogRate = currencyRates.find((row) => row.date <= date);
      // Carry the same account set through the whole series. Early FX is an explicit estimate too.
      const earliestRateDate = currencyRates.at(-1)?.date;
      const earliestRate = currencyRates.find((row) => row.date === earliestRateDate);
      const knownFrozen = account.observations.find((row) => row.frozenRate)?.frozenRate;
      const rate =
        account.currency === input.baseCurrency
          ? "1"
          : (catalogRate?.rate ?? anchor?.frozenRate ?? earliestRate?.rate ?? knownFrozen);
      invariant(rate && decimal(rate).gt(0), "回溯账户缺少可用汇率");
      if (account.currency !== input.baseCurrency && !catalogRate)
        fxFallbackAccounts.push({ id: account.id, name: account.name });
      const value = native.div(rate);
      if (account.side === "asset") assets = assets.plus(value);
      else liabilities = liabilities.minus(value);
    }
    const estimated = estimatedAccounts.length > 0 || fxFallbackAccounts.length > 0;
    days.push({
      date,
      assets: prepared.length ? assets.toFixed(10) : null,
      liabilities: prepared.length ? liabilities.toFixed(10) : null,
      netWorth: prepared.length ? assets.minus(liabilities).toFixed(10) : null,
      complete: prepared.length > 0 && !estimated && !excluded.length,
      estimated,
      estimatedAccounts,
      uncovered: [
        ...excluded,
        ...estimatedAccounts.map(({ id, name, coverageStart }) => ({
          id,
          name,
          reason: `流水覆盖始于 ${coverageStart}，此前按最早已知余额估计`,
        })),
      ],
      fxFallbackAccounts,
      observations: input.observations
        .filter((row) => row.date === date)
        .toSorted((a, b) => a.snapshotId.localeCompare(b.snapshotId)),
    });
  }
  return {
    from: input.from,
    to: input.to,
    baseCurrency: input.baseCurrency,
    days,
    excluded,
    accountIds: prepared.map((account) => account.id),
    plaidAvailability: input.plaidAvailability ?? null,
    observationOnlyAccounts: prepared
      .filter((account) => account.observationOnly)
      .map(({ id, name }) => ({ id, name })),
  };
}
export type BackcastSeries = ReturnType<typeof buildBackcast>;
