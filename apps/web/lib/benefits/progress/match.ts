import { addDays } from "./dates";
import { keywordHits, normalize } from "./normalize";
import type { BenefitEntry, Credit, CreditVersion, Override, ProgressInput } from "./types";
export function effective(version: CreditVersion, date: string, withLag = false): boolean {
  return (
    (!version.effective_from || version.effective_from <= date) &&
    (!version.effective_to ||
      date <= addDays(version.effective_to, withLag ? (version.max_posting_lag_days ?? 0) : 0))
  );
}
export function overrideAt(overrides: Override[], credit: string, date: string) {
  return overrides
    .filter((item) => item.credit === credit && (!item.effective_from || item.effective_from <= date))
    .sort((a, b) => (b.effective_from ?? "").localeCompare(a.effective_from ?? ""))[0];
}
export function matchEntry(
  entry: BenefitEntry,
  input: ProgressInput,
): { credit: string | null; reason?: string } {
  const none = (reason: string) => ({ credit: null, reason });
  if (!input.account.product_id || input.account.product_id !== input.catalog.id) return none("no_product");
  if (entry.currency !== input.catalog.currency) return none("currency_mismatch");
  const credits = input.catalog.credits.filter(
    (credit) => !credit.delivery || credit.delivery === "statement_credit",
  );
  const choose = (credit: Credit) =>
    overrideAt(input.overrides, credit.id, entry.assigned_period_start ?? entry.date)?.disabled
      ? none("credit_disabled")
      : { credit: credit.id };
  if (entry.assigned_credit !== undefined) {
    if (entry.assigned_credit === null) return none("owner_none");
    const credit = credits.find((credit) => credit.id === entry.assigned_credit);
    return credit?.versions.some((version) => effective(version, entry.assigned_period_start ?? entry.date))
      ? choose(credit)
      : none("no_effective_version");
  }
  const text = `${entry.description ?? ""} ${entry.merchant ?? ""}`;
  const allowed = credits.filter(
    (credit) => !credit.match.exclude?.some((keyword) => keywordHits(text, keyword)),
  );
  const hits = allowed.flatMap((credit) => {
    const lengths = credit.match.keywords
      .filter((keyword) => keywordHits(text, keyword))
      .map((keyword) => [...normalize(keyword)].length);
    return lengths.length ? [{ credit, length: Math.max(...lengths) }] : [];
  });
  const candidates = hits
    .filter(({ credit }) => credit.versions.some((version) => effective(version, entry.date, true)))
    .sort((a, b) => b.length - a.length);
  if (candidates.length) {
    if (candidates[1]?.length === candidates[0].length) return none("ambiguous");
    return choose(candidates[0].credit);
  }
  if (hits.length) return none("no_effective_version");
  const families = entry.family
    ? allowed.filter(
        (credit) =>
          credit.family === entry.family &&
          credit.versions.some((version) => effective(version, entry.date, true)),
      )
    : [];
  if (families.length > 1) return none("ambiguous");
  return families.length ? choose(families[0]) : none("no_match");
}
