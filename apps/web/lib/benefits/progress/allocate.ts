import { money, sumMoney } from "@/lib/money";
import { addDays } from "./dates";
import type { AllocatedPeriod } from "./periods";
import type { BenefitEntry } from "./types";
export const entryOrder = (a: BenefitEntry, b: BenefitEntry) =>
  a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
export const periodUsed = (period: AllocatedPeriod) => sumMoney(period.entries.map((entry) => entry.amount));
export function allocate(periods: AllocatedPeriod[], entries: BenefitEntry[]): string[] {
  const unplaced: BenefitEntry[] = [],
    orphans: BenefitEntry[] = [];
  for (const entry of [...entries].sort(entryOrder)) {
    const period = entry.assigned_period_start
      ? periods.find((period) => period.start === entry.assigned_period_start)
      : periods.find((period) => period.start <= entry.date && entry.date <= period.end);
    if (period) period.entries.push(entry);
    else if (entry.assigned_period_start) unplaced.push(entry);
    else orphans.push(entry);
  }
  const destination = (entry: BenefitEntry, before: number) =>
    periods
      .slice(0, before)
      .findLast(
        (period) =>
          period.end < entry.date &&
          entry.date <= addDays(period.end, period.lag) &&
          money(period.cap).plus(period.tolerance).minus(periodUsed(period)).gte(entry.amount),
      );
  for (const [k, period] of periods.entries()) {
    while (periodUsed(period).gt(money(period.cap).plus(period.tolerance))) {
      const move = period.entries
        .filter((entry) => !entry.assigned_period_start)
        .sort(entryOrder)
        .map((entry) => ({ entry, to: destination(entry, k) }))
        .find(({ to }) => to);
      if (!move?.to) break;
      period.entries = period.entries.filter((entry) => entry.id !== move.entry.id);
      move.to.entries.push(move.entry);
    }
  }
  for (const entry of orphans) {
    const to = destination(entry, periods.length);
    if (to) to.entries.push(entry);
    else unplaced.push(entry);
  }
  for (const period of periods) period.entries.sort(entryOrder);
  return unplaced.sort(entryOrder).map((entry) => entry.id);
}
