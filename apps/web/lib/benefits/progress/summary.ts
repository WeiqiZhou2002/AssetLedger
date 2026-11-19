import { money, sumMoney } from "@/lib/money";
import { addDays, addYears } from "./dates";
import { entryOrder, periodUsed } from "./allocate";
import { overrideAt } from "./match";
import type { AllocatedPeriod } from "./periods";
import type { BenefitEntry, CreditVersion, Override, Period, YearSummary } from "./types";
const nonnegative = (value: ReturnType<typeof money>) => (value.lt(0) ? "0.00" : value.toFixed(4));
export function summarizePeriod(period: AllocatedPeriod, asOf: string): Period {
  const used = periodUsed(period),
    cap = money(period.cap);
  return {
    start: period.start,
    end: period.end,
    cap: period.cap,
    used: used.toFixed(4),
    remaining: nonnegative(cap.minus(used)),
    excess: nonnegative(used.minus(cap).minus(period.tolerance)),
    state:
      period.start > asOf
        ? "upcoming"
        : used.isZero()
          ? "unused"
          : used.lt(cap)
            ? "partial"
            : used.lte(cap.plus(period.tolerance))
              ? "full"
              : "over",
    entries: period.entries.map((entry) => entry.id),
  };
}
export function summarizeYear(
  year: { start: string; end: string },
  periods: Period[],
  asOf: string,
): YearSummary {
  const sum = (rows: Period[], key: "cap" | "used" | "remaining" | "excess") =>
    sumMoney(rows.map((p) => p[key])).toFixed(4);
  return {
    ...year,
    cap: sum(periods, "cap"),
    used: sum(periods, "used"),
    expired_unused: sum(
      periods.filter((p) => p.end < asOf),
      "remaining",
    ),
    available: sum(
      periods.filter((p) => p.start <= asOf && p.end >= asOf),
      "remaining",
    ),
    upcoming: sum(
      periods.filter((p) => p.start > asOf),
      "cap",
    ),
    excess: sum(periods, "excess"),
  };
}
export function multiYear(
  credit: string,
  version: CreditVersion,
  entries: BenefitEntry[],
  reference: string,
  overrides: Override[],
) {
  const windows: {
    start: string;
    end: string;
    cap: string;
    used: string;
    next_eligible_on: string;
    entries: string[];
  }[] = [];
  for (const entry of [...entries].sort(entryOrder)) {
    const previous = windows.at(-1);
    if (previous && entry.date <= previous.end) {
      previous.used = money(previous.used).plus(entry.amount).toFixed(4);
      previous.entries.push(entry.id);
    } else {
      const next = addYears(entry.date, version.period_years!);
      windows.push({
        start: entry.date,
        end: addDays(next, -1),
        cap: overrideAt(overrides, credit, entry.date)?.amount ?? version.amount!,
        used: entry.amount,
        next_eligible_on: next,
        entries: [entry.id],
      });
    }
  }
  const current = windows.find((window) => window.start <= reference && reference <= window.end);
  if (!current) return { eligible: true, window: null, entries: [] as string[] };
  const { entries: ids, ...window } = current;
  return { eligible: false, window, entries: ids };
}
