import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { catalog, engineProduct, parseCatalog } from "@/lib/benefits/catalog";
import { benefitProgress } from "@/lib/benefits/progress";
import type { ProgressInput } from "@/lib/benefits/progress";
import lock from "@/lib/benefits/catalog/credits.lock.json";
import feed from "@/lib/benefits/catalog/credits.json";
import { syntheticCatalog } from "./helpers/benefit-catalog";
import vectors from "./fixtures/cardfacts/credit-vectors.json";
it("verifies both vendored byte hashes and the pinned contract", async () => {
  for (const file of [lock.feed, lock.vectors]) {
    const bytes = await readFile(new URL(`../lib/benefits/catalog/${file.path}`, import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
  }
  expect(catalog.catalogVersion).toBe(lock.catalog_version);
  expect(catalog.cards.length).toBeGreaterThan(0);
  expect(catalog.cards.flatMap((card) => card.credits).length).toBeGreaterThan(0);
  expect(() => parseCatalog({ ...feed, api_version: 2 })).toThrow();
});
it("parses a synthetic feed with null coverage", () => {
  const cards = syntheticCatalog().cards;
  cards[0].coverage = null;
  const parsed = parseCatalog({
    api_version: 1,
    catalog_version: "synthetic",
    data: { contract: { name: "credit-progress", format_version: 1 }, cards },
  });
  expect(parsed.cards[0].coverage).toBeNull();
});
function input(): ProgressInput {
  return structuredClone(vectors.data.vectors[0]);
}
it.each(["reset_basis", "period"] as const)("tolerates an unknown %s in an additive feed", (field) => {
  const synthetic = {
    api_version: 1,
    catalog_version: "synthetic",
    data: { contract: { name: "credit-progress", format_version: 1 }, cards: syntheticCatalog().cards },
  };
  const card = synthetic.data.cards[0];
  card.credits[0].versions[0][field] = "future_rule";
  const parsed = parseCatalog(synthetic);
  const product = engineProduct(parsed.cards[0]);
  const setup = input();
  setup.catalog = product;
  setup.account.product_id = product.id;
  setup.entries[0].description = product.credits[0].match.keywords[0];
  const result = benefitProgress(setup);
  expect(result.instances[0].status).toBe("unsupported");
  expect(result.matches.e1).toBe(product.credits[0].id);
});
it("lists unsupported credits without periods and never matches wallet or app benefits", () => {
  const setup = input(),
    credit = setup.catalog.credits[0];
  credit.versions[0].tracking = { supported: false, reasons: ["reset_basis_outside_contract"] };
  setup.catalog.credits.push(
    { ...structuredClone(credit), id: "wallet", delivery: "issuer_wallet" },
    { ...structuredClone(credit), id: "app", delivery: "in_app" },
  );
  setup.entries.push({ ...setup.entries[0], id: "owner-wallet", assigned_credit: "wallet" });
  const result = benefitProgress(setup);
  expect(result.instances).toHaveLength(1);
  expect(result.instances[0]).toMatchObject({ status: "unsupported", entries: ["e1", "e2"] });
  expect(result.informational.map((credit) => credit.credit)).toEqual(["wallet", "app"]);
  expect(result.matches["owner-wallet"]).toBeNull();
});
it("calculates conditional benefits normally, treating null lag as zero", () => {
  const setup = input();
  const version = setup.catalog.credits[0].versions[0];
  version.conditions = {
    minimum_spend: { amount: "100", period: "benefit_period" },
    minimum_nights: 2,
    consecutive_months: 3,
  };
  version.tracking = { supported: false, reasons: ["eligibility_conditions"] };
  version.max_posting_lag_days = null;
  const result = benefitProgress(setup);
  expect(result.instances[0]).toMatchObject({
    status: "ok",
    conditions: version.conditions,
    latest_entry: { id: "e2", date: "2026-02-03", amount: "7.50" },
    current_period: { start: "2026-03-01" },
  });
});
it("keeps ended credits in their historical year and filters informational versions by reference date", () => {
  const setup = input();
  setup.as_of = "2026-10-31";
  setup.catalog.credits[0].versions[0].effective_to = "2026-06-30";
  setup.catalog.credits.push({
    ...structuredClone(setup.catalog.credits[0]),
    id: "wallet",
    delivery: "issuer_wallet",
  });
  const result = benefitProgress(setup);
  expect(result.instances[0]).toMatchObject({ status: "ok", year: { cap: "60.0000" } });
  expect(result.informational).toEqual([]);
});
it.each(["to_verify", "unsupported"])(
  "never allocates entries from an old %s version into known terms",
  (kind) => {
    const setup = input();
    const credit = setup.catalog.credits[0];
    const base = credit.versions[0];
    credit.versions = [
      { ...base, effective_to: "2026-01-31", max_posting_lag_days: 90 },
      {
        ...base,
        effective_from: "2026-02-01",
        effective_to: "2026-02-28",
        status: kind === "to_verify" ? "to_verify" : "verified",
        reset_basis: kind === "unsupported" ? "future_basis" : "calendar",
      },
      { ...base, effective_from: "2026-03-01" },
    ];
    setup.entries = [{ ...setup.entries[0], id: "old", date: "2026-02-05", amount: "7" }];
    const result = benefitProgress(setup);
    expect(result.matches.old).toBe("coffee");
    expect(result.instances[0]).toMatchObject({
      status: "ok",
      year: { used: "0.0000" },
      unplaced: ["old"],
      entry_details: [{ id: "old" }],
    });
  },
);
it("keeps an orphan before tracking_start unplaced instead of moving it forward", () => {
  const setup = input();
  setup.account.tracking_start = "2026-03-01";
  setup.catalog.credits[0].versions[0].max_posting_lag_days = 90;
  const result = benefitProgress(setup);
  expect(result.instances[0]).toMatchObject({
    status: "ok",
    year: { used: "0.0000" },
    unplaced: ["e1", "e2"],
  });
});
it("treats prototype property names as unknown periods", () => {
  const setup = input();
  setup.catalog.credits[0].versions[0].period = "constructor";
  expect(benefitProgress(setup).instances[0].status).toBe("unsupported");
});
