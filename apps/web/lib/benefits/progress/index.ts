import { addDays, addYears } from "./dates";
import { allocate, entryOrder } from "./allocate";
import { effective, matchEntry, overrideAt } from "./match";
import { benefitYear, generatePeriods, missingBasis, supported } from "./periods";
import { multiYear, summarizePeriod, summarizeYear } from "./summary";
import type { InformationalCredit, InstanceMetadata, ProgressInput, ProgressInstance } from "./types";
export type { ProgressInput, ProgressInstance } from "./types";
export function benefitProgress(input: ProgressInput) {
  const matches: Record<string, string | null> = {};
  const unmatched: { entry: string; reason: string }[] = [];
  for (const entry of input.entries) {
    const match = matchEntry(entry, input);
    matches[entry.id] = match.credit;
    if (match.reason) unmatched.push({ entry: entry.id, reason: match.reason });
  }
  const instances: ProgressInstance[] = [],
    informational: InformationalCredit[] = [];
  if (input.account.product_id !== input.catalog.id) return { matches, unmatched, instances, informational };
  const reference =
    input.view_year === Number(input.as_of.slice(0, 4)) ? input.as_of : `${input.view_year}-12-31`;
  for (const credit of input.catalog.credits) {
    const versions = [...credit.versions].sort((a, b) =>
      (b.effective_from ?? "").localeCompare(a.effective_from ?? ""),
    );
    const inEffect = versions.find((version) => effective(version, reference));
    const version =
      inEffect ?? versions.find((version) => !version.effective_from || version.effective_from <= reference);
    if (!version || overrideAt(input.overrides, credit.id, reference)?.disabled) continue;
    if (credit.delivery && credit.delivery !== "statement_credit") {
      if (inEffect)
        informational.push({
          credit: credit.id,
          name: credit.name,
          amount: version.amount,
          period: version.period,
          period_years: version.period_years ?? null,
          delivery: credit.delivery,
        });
      continue;
    }
    const entries = input.entries.filter((entry) => matches[entry.id] === credit.id).sort(entryOrder);
    const metadata: InstanceMetadata = {
      credit: credit.id,
      name: credit.name,
      category: credit.category ?? null,
      enrollment: credit.enrollment ?? "unknown",
      amount: version.amount,
      period: version.period,
      period_years: version.period_years ?? null,
      reset_basis: version.reset_basis,
      conditions: version.conditions ?? null,
      terms_as_of: version.effective_from === null ? (version.last_verified ?? null) : null,
      latest_entry: entries.at(-1) ?? null,
      entry_details: entries,
    };
    const status = !supported(version)
      ? "unsupported"
      : version.status === "to_verify" || version.amount === null
        ? "to_verify"
        : missingBasis(version, input.account);
    if (status) {
      instances.push({ ...metadata, status, entries: entries.map((entry) => entry.id) });
      continue;
    }
    // A directly applicable version takes precedence over a previous version's posting lag.
    // Pending/unsupported terms still match, but their entries must never consume a known cap.
    const allocatable = entries.filter((entry) => {
      const date = entry.assigned_period_start ?? entry.date;
      const terms =
        versions.find((candidate) => effective(candidate, date)) ??
        versions.find((candidate) => effective(candidate, date, true));
      return terms && supported(terms) && terms.status !== "to_verify" && terms.amount !== null;
    });
    const excludedIds = entries.filter((entry) => !allocatable.includes(entry)).map((entry) => entry.id);
    if (version.period === "multi_year") {
      instances.push({
        ...metadata,
        status: "ok",
        ...multiYear(credit.id, version, allocatable, reference, input.overrides),
        unplaced: excludedIds,
      });
      continue;
    }
    const year = benefitYear(version, input.account, reference);
    // Allocate across the full evidence horizon before selecting the display year. Earlier
    // periods must remain available for overflow moves, including moves across term versions.
    const dates = [
      year.start,
      ...entries.flatMap((entry) => [
        entry.date,
        ...(entry.assigned_period_start ? [entry.assigned_period_start] : []),
      ]),
    ].sort();
    const lag = Math.max(0, ...credit.versions.map((version) => version.max_posting_lag_days ?? 0));
    const from = addDays(addYears(dates[0], -1), -lag);
    const to = [year.end, input.as_of, ...dates].sort().at(-1)!;
    const allocated = generatePeriods(credit, input.account, input.overrides, from, to);
    const unplacedIds = new Set([...excludedIds, ...allocate(allocated, allocatable)]);
    const unplaced = entries.filter((entry) => unplacedIds.has(entry.id)).map((entry) => entry.id);
    const periods = allocated
      .filter((period) => year.start <= period.start && period.start <= year.end)
      .map((period) => summarizePeriod(period, input.as_of));
    if (!periods.length) continue;
    const current =
      periods.find((period) => period.start <= input.as_of && input.as_of <= period.end) ??
      (input.view_year < Number(input.as_of.slice(0, 4)) ? periods.at(-1)! : null);
    instances.push({
      ...metadata,
      status: "ok",
      year: summarizeYear(year, periods, input.as_of),
      periods,
      current_period: current,
      unplaced,
    });
  }
  return { matches, unmatched, instances, informational };
}
