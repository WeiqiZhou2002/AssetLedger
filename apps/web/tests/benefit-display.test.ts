import { expect, it } from "vitest";
import { benefitProgress, type ProgressInput } from "@/lib/benefits/progress";
import { applyBenefitMarks, type BenefitMark, type DisplayInstance } from "@/lib/benefits/marks";
import {
  creditYearReimbursed,
  creditStatus,
  groupCredits,
  isUnqualifiedConditional,
} from "@/lib/benefits/display";
import { formatBenefitAmount } from "@/components/benefits/amount";
import { engineProduct } from "@/lib/benefits/catalog";
import { syntheticCatalog } from "./helpers/benefit-catalog";
function input(): ProgressInput {
  const catalog = engineProduct(syntheticCatalog().cards[0]);
  return {
    catalog,
    account: {
      product_id: catalog.id,
      currency: "USD",
      anniversary: null,
      statement_close_day: null,
      tracking_start: null,
    },
    entries: [],
    overrides: [],
    as_of: "2026-06-15",
    view_year: 2026,
  };
}
const display = (value: ProgressInput, marks: BenefitMark[] = []) =>
  applyBenefitMarks(benefitProgress(value).instances, marks, value.catalog.id, value.as_of);
const entry = (id: string, amount: string, date = "2026-06-01") => ({
  id,
  amount,
  date,
  currency: "USD",
  description: "BEANHOUSE CREDIT",
});
const mark = (value: ProgressInput): BenefitMark => ({
  catalogProductId: value.catalog.id,
  creditId: "coffee",
  periodStart: "2026-06-01",
  periodEnd: "2027-05-31",
});
it("sums real refund details by calendar year and inclusive as-of date without adding marked money", () => {
  const value = input();
  value.entries = [
    entry("old", "9", "2025-12-31"),
    entry("first", "0.1001", "2026-01-01"),
    entry("today", "0.2002", value.as_of),
    entry("future", "7", "2026-06-16"),
  ];
  const original = display(value)[0];
  expect(creditYearReimbursed(original, "2026", value.as_of)).toBe("0.3003");
  expect(creditYearReimbursed(original, "2025", value.as_of)).toBe("9.0000");
  expect(creditYearReimbursed(original, "2024", value.as_of)).toBe("0.0000");
  expect(creditYearReimbursed(display(value, [mark(value)])[0], "2026", value.as_of)).toBe("0.3003");
});
it.each(["periodic", "estimated", "multi_year"])("marks add no money for %s credits", (kind) => {
  const value = input();
  const version = value.catalog.credits[0].versions[0];
  if (kind === "estimated") version.reset_basis = "anniversary";
  if (kind === "multi_year")
    Object.assign(version, { period: "multi_year", reset_basis: "since_last_credit", period_years: 4 });
  expect(creditYearReimbursed(display(value, [mark(value)])[0], "2026", value.as_of)).toBe("0.0000");
});
it.each([
  ["0", "unused"],
  ["7", "partial"],
  ["10", "used"],
  ["12", "used"],
])("maps periodic amount %s to %s", (amount, status) => {
  const value = input();
  value.entries = [entry("refund", amount)];
  expect(creditStatus(display(value)[0], value.as_of)).toBe(status);
  expect(creditStatus(display(value, [mark(value)])[0], value.as_of)).toBe("used");
});
it("maps a current upcoming period and returns null without a current period", () => {
  const value = input();
  const instance = display(value)[0];
  if (instance.status !== "ok" || !("year" in instance)) throw new Error("Expected periodic credit");
  const upcoming = instance.periods.find((period) => period.state === "upcoming")!;
  expect(creditStatus({ ...instance, current_period: upcoming }, value.as_of)).toBe("upcoming");
  value.view_year = 2027;
  expect(creditStatus(display(value)[0], value.as_of)).toBeNull();
});
it("does not label the engine's last past-year period as current", () => {
  const value = input();
  value.view_year = 2025;
  value.catalog.credits[0].versions[0].period = "quarterly";
  value.entries = [entry("historical-refund", "3", "2025-12-01")];
  const instance = display(value)[0];
  expect(instance).toMatchObject({ current_period: { start: "2025-10-01", end: "2025-12-31" } });
  expect(creditStatus(instance, value.as_of, "2025")).toBeNull();
  expect(creditYearReimbursed(instance, "2025", value.as_of)).toBe("3.0000");
});
it("keeps the periodic status through the inclusive end date", () => {
  const value = input();
  value.as_of = "2026-06-30";
  expect(creditStatus(display(value)[0], value.as_of)).toBe("unused");
});
it.each(["periodic", "estimated"])(
  "labels unqualified %s credits as conditional before usage status",
  (kind) => {
    const value = input();
    const version = value.catalog.credits[0].versions[0];
    version.conditions = { consecutive_months: 3 };
    if (kind === "estimated") version.reset_basis = "anniversary";
    expect(creditStatus(display(value)[0], value.as_of)).toBe("conditional");
    expect(creditStatus(display(value, [mark(value)])[0], value.as_of)).toBe("used");
    value.entries = [entry("refund", "3")];
    expect(creditStatus(display(value)[0], value.as_of)).toBe("partial");
  },
);
it("keeps the conditional label for unqualified past-year periodic credits", () => {
  const value = input();
  value.view_year = 2025;
  value.catalog.credits[0].versions[0].conditions = { consecutive_months: 3 };
  expect(creditStatus(display(value)[0], value.as_of, "2025")).toBe("conditional");
});
it.each([false, true])(
  "hides estimated window status in past years, including conditional=%s",
  (conditional) => {
    const value = input();
    value.view_year = 2025;
    const version = value.catalog.credits[0].versions[0];
    version.reset_basis = "anniversary";
    if (conditional) version.conditions = { consecutive_months: 3 };
    value.entries = [entry("historical-refund", "3", "2025-01-01")];
    const instance = display(value)[0];
    expect(instance).toMatchObject({
      status: "estimated",
      window: { start: "2025-06-16", end: value.as_of },
    });
    expect(creditStatus(instance, value.as_of, "2025")).toBeNull();
    expect(creditStatus(display(value, [mark(value)])[0], value.as_of, "2025")).toBeNull();
    expect(creditYearReimbursed(instance, "2025", value.as_of)).toBe("3.0000");
  },
);
it.each([
  ["0", "unused"],
  ["7", "partial"],
  ["10", "used"],
  ["12", "used"],
])("maps estimated amount %s to %s", (amount, status) => {
  const value = input();
  value.catalog.credits[0].versions[0].reset_basis = "anniversary";
  value.entries = [entry("refund", amount)];
  expect(creditStatus(display(value)[0], value.as_of)).toBe(status);
  expect(creditStatus(display(value, [mark(value)])[0], value.as_of)).toBe("used");
});
it("maps multi-year eligibility and cooldown, including manual marks", () => {
  const value = input();
  Object.assign(value.catalog.credits[0].versions[0], {
    period: "multi_year",
    reset_basis: "since_last_credit",
    period_years: 4,
  });
  expect(creditStatus(display(value)[0], value.as_of)).toBe("eligible");
  expect(creditStatus(display(value, [mark(value)])[0], value.as_of)).toBe("cooldown");
  value.entries = [entry("refund", "10")];
  expect(creditStatus(display(value)[0], value.as_of)).toBe("cooldown");
});
it.each(["to_verify", "unsupported"])("has no status for %s", (kind) => {
  const value = input();
  if (kind === "to_verify") value.catalog.credits[0].versions[0].status = kind;
  else value.catalog.credits[0].versions[0].period = "future";
  expect(creditStatus(display(value)[0], value.as_of)).toBeNull();
});
it.each(["periodic", "estimated"])("qualifies %s conditions only after a refund or mark", (kind) => {
  const value = input();
  const version = value.catalog.credits[0].versions[0];
  expect(isUnqualifiedConditional(display(value)[0])).toBe(false);
  version.conditions = { minimum_spend: { amount: "50", period: "benefit_period" } };
  if (kind === "estimated") version.reset_basis = "anniversary";
  const original = display(value)[0];
  expect(isUnqualifiedConditional(original)).toBe(true);
  expect(isUnqualifiedConditional(display(value, [mark(value)])[0])).toBe(false);
  if (kind === "periodic")
    expect(
      isUnqualifiedConditional(
        display(value, [{ ...mark(value), periodStart: "2026-02-01", periodEnd: "2026-02-28" }])[0],
      ),
    ).toBe(false);
  value.entries = [entry("refund", "3")];
  expect(isUnqualifiedConditional(display(value)[0])).toBe(false);
  expect(isUnqualifiedConditional(original)).toBe(true);
});
it("orders reimbursed credits first and folds only unreimbursed conditional and untracked credits", () => {
  const value = input();
  const kinds = [
    "unused",
    "conditional",
    "paid-conditional",
    "estimated",
    "multi_year",
    "to_verify",
    "paid-unsupported",
    "unsupported",
    "paid-multi_year",
  ];
  const base = value.catalog.credits[0];
  value.catalog.credits = kinds.map((kind) => {
    const credit = structuredClone(base);
    credit.id = kind;
    credit.match.keywords = [kind];
    const version = credit.versions[0];
    if (kind.includes("conditional")) version.conditions = { consecutive_months: 3 };
    if (kind === "estimated") version.reset_basis = "anniversary";
    if (kind.includes("multi_year"))
      Object.assign(version, { period: "multi_year", period_years: 4, reset_basis: "since_last_credit" });
    if (kind === "to_verify") version.status = kind;
    if (kind.includes("unsupported")) version.period = "future";
    return credit;
  });
  value.entries = kinds
    .filter((kind) => kind.startsWith("paid-"))
    .map((kind) => ({ ...entry(kind, "3"), description: kind, assigned_credit: kind }));
  const instances = display(value),
    before = structuredClone(instances);
  const reimbursed = Object.fromEntries(
    instances.map((instance) => [instance.credit, creditYearReimbursed(instance, "2026", value.as_of)]),
  );
  const grouped = groupCredits(instances, reimbursed);
  const ids = (rows: DisplayInstance[]) => rows.map((row) => row.credit);
  expect(ids(grouped.main)).toEqual([
    "paid-conditional",
    "paid-unsupported",
    "paid-multi_year",
    "unused",
    "estimated",
  ]);
  expect(ids(grouped.other)).toEqual(["conditional", "multi_year", "to_verify", "unsupported"]);
  expect(instances).toEqual(before);
  expect(groupCredits([], {})).toEqual({ main: [], other: [] });
});
it.each([
  ["1526.0000", "USD", "$1,526"],
  ["1526.5000", "USD", "$1,526.50"],
  ["1526", "EUR", "EUR 1,526"],
  ["1526.50", "CAD", "CAD 1,526.50"],
  ["-1526.50", "USD", "$-1,526.50"],
  ["0", "USD", "$0"],
])("formats %s %s as %s", (amount, currency, expected) => {
  expect(formatBenefitAmount(amount, currency)).toBe(expected);
});
