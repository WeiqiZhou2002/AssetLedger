import { expect, it } from "vitest";
import { benefitProgress, type ProgressInput } from "@/lib/benefits/progress";
import { applyBenefitMarks, type BenefitMark } from "@/lib/benefits/marks";
import { benefitTotals, isUnqualifiedConditional } from "@/lib/benefits/totals";
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
it("excludes unqualified conditional periods from caps and expiration until a refund or mark qualifies them", () => {
  const value = input();
  value.catalog.credits[0].versions[0].conditions = {
    minimum_spend: { amount: "50", period: "benefit_period" },
  };
  const original = display(value);
  expect(isUnqualifiedConditional(original[0])).toBe(true);
  expect(benefitTotals(original)).toEqual({
    cap: "0.0000",
    used: "0.0000",
    expiredUnused: "0.0000",
    remaining: "0.0000",
    conditionalCap: "120.0000",
    excluded: { multiYear: 0, untracked: 0 },
  });
  const marked = display(value, [
    {
      catalogProductId: value.catalog.id,
      creditId: "coffee",
      periodStart: "2026-02-01",
      periodEnd: "2026-02-28",
    },
  ]);
  expect(isUnqualifiedConditional(marked[0])).toBe(false);
  expect(benefitTotals(marked)).toMatchObject({
    cap: "120.0000",
    used: "10.0000",
    expiredUnused: "40.0000",
    remaining: "70.0000",
    conditionalCap: "0.0000",
  });
  value.entries = [
    {
      id: "synthetic-entry",
      date: "2026-06-01",
      amount: "3",
      currency: "USD",
      description: "BEANHOUSE CREDIT",
    },
  ];
  expect(benefitTotals(display(value))).toMatchObject({
    cap: "120.0000",
    used: "3.0000",
    expiredUnused: "50.0000",
    remaining: "67.0000",
    conditionalCap: "0.0000",
  });
  expect(benefitTotals(original).conditionalCap).toBe("120.0000");
});
it("gates estimated conditional windows and includes marked rolling amounts", () => {
  const value = input();
  Object.assign(value.catalog.credits[0].versions[0], {
    reset_basis: "anniversary",
    conditions: { consecutive_months: 3 },
  });
  expect(benefitTotals(display(value))).toMatchObject({ cap: "0.0000", conditionalCap: "10.0000" });
  const marked = display(value, [
    {
      catalogProductId: value.catalog.id,
      creditId: "coffee",
      periodStart: "2026-06-01",
      periodEnd: "2027-05-31",
    },
  ]);
  expect(benefitTotals(marked)).toMatchObject({
    cap: "10.0000",
    used: "10.0000",
    remaining: "0.0000",
    conditionalCap: "0.0000",
  });
});
it("counts multi-year, unsupported and to-verify exclusions without annualizing them", () => {
  const value = input();
  const base = value.catalog.credits[0];
  value.catalog.credits = ["multi_year", "unsupported", "to_verify"].map((kind) => {
    const credit = structuredClone(base);
    credit.id = kind;
    if (kind === "multi_year")
      Object.assign(credit.versions[0], {
        period: "multi_year",
        reset_basis: "since_last_credit",
        period_years: 4,
      });
    else if (kind === "unsupported") credit.versions[0].period = "future";
    else credit.versions[0].status = "to_verify";
    return credit;
  });
  expect(benefitTotals(display(value))).toEqual({
    cap: "0.0000",
    used: "0.0000",
    expiredUnused: "0.0000",
    remaining: "0.0000",
    conditionalCap: "0.0000",
    excluded: { multiYear: 1, untracked: 2 },
  });
});
