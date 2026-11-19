import { money } from "@/lib/money";
import { addDays, addMonths, addYears, monthDistance, statementOnOrAfter } from "./dates";
import { overrideAt } from "./match";
import type { Account, BenefitEntry, Credit, CreditVersion, Override } from "./types";
export type AllocatedPeriod = {
  start: string;
  end: string;
  cap: string;
  tolerance: string;
  lag: number;
  entries: BenefitEntry[];
};
const steps: Record<string, number> = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };
export function supported(version: CreditVersion): boolean {
  if (version.tracking?.reasons.includes("reset_basis_outside_contract")) return false;
  if (version.period === "multi_year")
    return (
      version.reset_basis === "since_last_credit" && Boolean(version.period_years && version.period_years > 0)
    );
  return (
    Object.hasOwn(steps, version.period) &&
    (version.reset_basis === "calendar" ||
      version.reset_basis === "anniversary" ||
      (version.reset_basis === "anniversary_statement" && version.period === "annual"))
  );
}
export function missingBasis(version: CreditVersion, account: Account) {
  if (["anniversary", "anniversary_statement"].includes(version.reset_basis) && !account.anniversary)
    return "needs_anniversary" as const;
  if (version.reset_basis === "anniversary_statement" && !account.statement_close_day)
    return "needs_statement_day" as const;
  return null;
}
function statementYear(account: Account, k: number) {
  const anchor = account.anniversary!;
  const close = account.statement_close_day!;
  return {
    start: k === 1 ? anchor : addDays(statementOnOrAfter(addYears(anchor, k - 1), close), 1),
    end: statementOnOrAfter(addYears(anchor, k), close),
  };
}
export function benefitYear(version: CreditVersion, account: Account, reference: string) {
  if (version.reset_basis === "anniversary_statement") {
    let k = Math.max(1, Math.floor(monthDistance(account.anniversary!, reference) / 12));
    while (statementYear(account, k).end < reference) k++;
    return statementYear(account, k);
  }
  if (version.reset_basis === "anniversary") {
    const anchor = account.anniversary!;
    let k = Math.floor(monthDistance(anchor, reference) / 12);
    if (addYears(anchor, k) > reference) k--;
    return { start: addYears(anchor, k), end: addDays(addYears(anchor, k + 1), -1) };
  }
  return { start: `${reference.slice(0, 4)}-01-01`, end: `${reference.slice(0, 4)}-12-31` };
}
export function generatePeriods(
  credit: Credit,
  account: Account,
  overrides: Override[],
  from: string,
  to: string,
): AllocatedPeriod[] {
  const periods: AllocatedPeriod[] = [];
  for (const version of credit.versions) {
    if (
      !supported(version) ||
      missingBasis(version, account) ||
      version.status === "to_verify" ||
      version.amount === null ||
      version.period === "multi_year"
    )
      continue;
    const append = (raw: { start: string; end: string }) => {
      const start =
        version.effective_from && raw.start < version.effective_from ? version.effective_from : raw.start;
      const end = version.effective_to && raw.end > version.effective_to ? version.effective_to : raw.end;
      if (
        start > end ||
        end < from ||
        start > to ||
        (account.anniversary && end < account.anniversary) ||
        (account.tracking_start && end < account.tracking_start)
      )
        return;
      const override = overrideAt(overrides, credit.id, start);
      if (override?.disabled) return;
      const cap = override?.amount ?? version.amount!;
      periods.push({
        start,
        end,
        cap,
        tolerance: version.cap_excludes_tax ? money(cap).times("0.15").toFixed(2) : "0",
        lag: version.max_posting_lag_days ?? 0,
        entries: [],
      });
    };
    if (version.reset_basis === "anniversary_statement") {
      let k = Math.max(1, Math.floor(monthDistance(account.anniversary!, from) / 12));
      while (statementYear(account, k).start <= to) {
        append(statementYear(account, k));
        k++;
      }
    } else {
      const anchor = version.reset_basis === "calendar" ? `${from.slice(0, 4)}-01-01` : account.anniversary!;
      const step = steps[version.period];
      let k = Math.floor(monthDistance(anchor, from) / step) - 1;
      while (addMonths(anchor, k * step) <= to) {
        append({ start: addMonths(anchor, k * step), end: addDays(addMonths(anchor, (k + 1) * step), -1) });
        k++;
      }
    }
  }
  return periods.sort((a, b) => a.start.localeCompare(b.start));
}
