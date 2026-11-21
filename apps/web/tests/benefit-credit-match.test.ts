import { expect, it } from "vitest";
import { engineProduct, productById } from "@/lib/benefits/catalog";
import { creditTokens, matchBenefitCredits } from "@/lib/benefits/credit-match";
import { benefitProgress } from "@/lib/benefits/progress";
import type { Credit, ProgressInput } from "@/lib/benefits/progress/types";

function input(description: string, amount = "50"): ProgressInput {
  const catalog = engineProduct(productById("us-amex-business-platinum")!);
  return {
    catalog,
    account: {
      currency: "USD",
      product_id: catalog.id,
      anniversary: null,
      statement_close_day: null,
      tracking_start: null,
    },
    entries: [{ id: "synthetic-entry", description, amount, date: "2026-03-10", currency: "USD" }],
    overrides: [],
    as_of: "2026-11-20",
    view_year: 2026,
  };
}
function result(value: ProgressInput, assignments?: Map<string, string | null>) {
  const matched = matchBenefitCredits(value, assignments);
  return {
    match: matched.matches["synthetic-entry"],
    engine: benefitProgress({ ...value, entries: matched.entries }),
    entries: matched.entries,
  };
}
it.each([
  ["BUSINESS PLATINUM DELL TECHNOLOGIES CREDIT", "150", "dell", "fuzzy"],
  ["BUSINESS PLATINUM DELL TECHNOLOGIES CREDIT", "1000", "dell-spend", "amount"],
  ["HILTON FOR BUSINESS CREDIT", "50", "hilton", "fuzzy"],
  ["Amex HotelCredit", "50", "hotel", "fuzzy"],
  ["AMEX HOTELCREDIT", "50", "hotel", "fuzzy"],
  ["AMEX STATEMENT CREDIT", "50", null, null],
  ["WALMART+ MEMBERSHIP CREDIT", "50", null, null],
  ["UBER ONE PLUS CREDIT", "50", null, null],
  ["SYNTHETIC FEE CREDIT", "50", null, null],
  ["ZO CREDIT", "50", null, null],
  ["CLEAR CREDIT", "50", "clear", "fuzzy"],
  ["Dell Credit", "150", "dell", "keyword"],
  ["Dell Credit", "1000", "dell-spend", "amount"],
  ["CHATGPT BUSINESS REIMBURSEMENT", "50", "chatgpt-business", "fuzzy"],
  ["ChatGPT™ BUSINESS REIMBURSEMENT", "50", "chatgpt-business", "fuzzy"],
  ["TSA PreCheck® BENEFIT", "50", "trusted-traveler", "keyword"],
  ["PRECHECK BENEFIT", "50", null, null],
])("matches synthetic %s / %s", (description, amount, credit, source) => {
  const actual = result(input(description, amount));
  expect(actual.match).toEqual({
    automaticCreditId: credit,
    source,
    ownerAssigned: false,
    ownerCreditId: null,
  });
  expect(actual.engine.matches["synthetic-entry"]).toBe(credit);
});
function inlineCredit(id: string, name: string, amount = "100"): Credit {
  return {
    id,
    name,
    match: { keywords: [] },
    versions: [
      {
        effective_from: null,
        effective_to: null,
        status: "verified",
        amount,
        period: "annual",
        reset_basis: "calendar",
        max_posting_lag_days: null,
      },
    ],
  };
}
it("leaves exact fuzzy ties unresolved unless only one tied cap is sufficient", () => {
  const value = input("ORBIT REIMBURSEMENT", "50");
  value.catalog.credits = [inlineCredit("a", "Orbit North"), inlineCredit("b", "Orbit South")];
  expect(result(value).match.automaticCreditId).toBeNull();
  value.catalog.credits[0].versions[0].amount = "20";
  expect(result(value).match).toMatchObject({ automaticCreditId: "b", source: "amount" });
  value.catalog.credits[1].versions[0].amount = "20";
  expect(result(value).match.automaticCreditId).toBeNull();
});
it("honors exclusions, delivery, effectiveness and currency before fuzzy matching", () => {
  const value = input("ORBIT REIMBURSEMENT");
  const credit = inlineCredit("orbit", "Orbit Credit");
  value.catalog.credits = [credit];
  credit.match.exclude = ["REIMBURSEMENT"];
  expect(result(value).match.automaticCreditId).toBeNull();
  delete credit.match.exclude;
  credit.delivery = "issuer_wallet";
  expect(result(value).match.automaticCreditId).toBeNull();
  credit.delivery = "statement_credit";
  credit.versions[0].effective_from = "2026-04-01";
  expect(result(value).match.automaticCreditId).toBeNull();
  credit.versions[0].effective_from = null;
  credit.versions[0].effective_to = "2026-03-01";
  credit.versions[0].max_posting_lag_days = 30;
  expect(result(value).match.automaticCreditId).toBeNull();
  credit.match.keywords = ["ORBIT"];
  expect(result(value).engine.matches["synthetic-entry"]).toBe("orbit");
  expect(result(value).entries[0].assigned_credit).toBeUndefined();
  value.entries[0].currency = "EUR";
  expect(result(value).match.automaticCreditId).toBeNull();
});
it("keeps exact keyword matches ahead of stronger fuzzy matches and uses best score then smallest sufficient cap", () => {
  const value = input("ORBIT NORTH credit", "50");
  value.catalog.credits = [
    inlineCredit("keyword", "Orbit Credit", "100"),
    inlineCredit("north", "Orbit North Credit", "100"),
  ];
  value.catalog.credits[0].match.keywords = ["NORTH credit"];
  expect(result(value).match).toMatchObject({ automaticCreditId: "keyword", source: "keyword" });
  value.catalog.credits[0].versions[0].amount = "10";
  value.catalog.credits.push(inlineCredit("large", "Orbit North Credit", "200"));
  expect(result(value).match).toMatchObject({ automaticCreditId: "north", source: "amount" });
});
it("never moves an owner assignment and still exposes the automatic choice", () => {
  const value = input("Dell Credit", "1000");
  for (const choice of ["dell", null]) {
    const actual = result(value, new Map([["synthetic-entry", choice]]));
    expect(actual.match).toMatchObject({
      automaticCreditId: "dell-spend",
      ownerAssigned: true,
      ownerCreditId: choice,
    });
    expect(actual.engine.matches["synthetic-entry"]).toBe(choice);
  }
});
it("normalizes Unicode and glued suffixes, removes generic and digit tokens, and keeps distinctive words", () => {
  expect([...creditTokens("ＡＭＥＸ HOTELCREDIT Orbit123 ONE TRAVEL PLUS x", true)]).toEqual([
    "HOTELCREDIT",
    "ONE",
    "TRAVEL",
    "PLUS",
    "HOTEL",
  ]);
  expect([...creditTokens("ChatGPT™ TSA PreCheck®")]).toEqual(["CHATGPT", "TSA", "PRECHECK"]);
});
