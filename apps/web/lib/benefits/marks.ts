import { money, sumMoney } from "@/lib/money";
import { addDays, addYears } from "./progress/dates";
import { summarizeYear } from "./progress/summary";
import type { InstanceMetadata, Period, ProgressInstance } from "./progress/types";

export type BenefitMark = {
  catalogProductId: string;
  creditId: string;
  periodStart: string;
  periodEnd: string;
};
type MarkState = {
  marked?: boolean;
  detected_used?: string;
  activeMark?: { periodStart: string; periodEnd: string };
};
export type DisplayPeriod = Period & MarkState;
export type DisplayInstance = InstanceMetadata &
  MarkState &
  (
    | {
        status: "ok";
        year: Extract<ProgressInstance, { year: unknown }>["year"];
        periods: DisplayPeriod[];
        current_period: DisplayPeriod | null;
        unplaced: string[];
      }
    | Extract<ProgressInstance, { eligible: boolean }>
    | Extract<
        ProgressInstance,
        {
          entries: string[];
          status: "to_verify" | "unsupported" | "needs_anniversary" | "needs_statement_day";
        }
      >
    | {
        status: "estimated";
        window: { start: string; end: string; cap: string; used: string; remaining: string };
      }
  );
const bounds = (mark: BenefitMark) => ({ periodStart: mark.periodStart, periodEnd: mark.periodEnd });
const atLeast = (used: string, cap: string) => (money(used).gte(cap) ? money(used) : money(cap)).toFixed(4);

// Asset Ledger display layer; the shared engine and its evidence stay unchanged.
export function applyBenefitMarks(
  instances: ProgressInstance[],
  marks: BenefitMark[],
  productId: string,
  asOf: string,
): DisplayInstance[] {
  return instances.map((original): DisplayInstance => {
    const matching = marks.filter(
      (mark) => mark.catalogProductId === productId && mark.creditId === original.credit,
    );
    const active = matching
      .filter((mark) => mark.periodStart <= asOf && asOf <= mark.periodEnd)
      .sort((a, b) => b.periodStart.localeCompare(a.periodStart))[0];
    if (original.status === "needs_anniversary" || original.status === "needs_statement_day") {
      const start = addDays(addYears(asOf, -1), 1),
        cap = original.amount!;
      const detected = sumMoney(
        original.entry_details
          .filter((entry) => start <= entry.date && entry.date <= asOf)
          .map((entry) => entry.amount),
      ).toFixed(4);
      const used = active ? atLeast(detected, cap) : detected;
      const remaining = money(cap).minus(used);
      return {
        ...original,
        status: "estimated",
        window: {
          start,
          end: asOf,
          cap,
          used,
          remaining: remaining.gt(0) ? remaining.toFixed(4) : "0.0000",
        },
        ...(active ? { marked: true, detected_used: detected, activeMark: bounds(active) } : {}),
      };
    }
    if (original.status !== "ok") return original;
    if ("year" in original) {
      const periods = original.periods.map((period): DisplayPeriod => {
        const mark = matching.find((mark) => mark.periodStart === period.start);
        return mark
          ? {
              ...period,
              marked: true,
              activeMark: bounds(mark),
              detected_used: period.used,
              used: atLeast(period.used, period.cap),
              remaining: "0.0000",
              state: period.state === "over" ? "over" : "full",
            }
          : period;
      });
      return {
        ...original,
        periods,
        year: summarizeYear({ start: original.year.start, end: original.year.end }, periods, asOf),
        current_period: periods.find((period) => period.start === original.current_period?.start) ?? null,
      };
    }
    if (original.eligible && active)
      return {
        ...original,
        eligible: false,
        marked: true,
        activeMark: bounds(active),
        detected_used: "0.0000",
        window: {
          start: active.periodStart,
          end: active.periodEnd,
          cap: original.amount!,
          used: original.amount!,
          next_eligible_on: addDays(active.periodEnd, 1),
        },
      };
    return original;
  });
}
