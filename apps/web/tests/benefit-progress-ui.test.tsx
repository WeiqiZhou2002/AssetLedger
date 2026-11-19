import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BenefitProgressSection } from "@/components/benefits/progress";
import { benefitProgress } from "@/lib/benefits/progress";
import { sumMoney } from "@/lib/money";
import { engineProduct } from "@/lib/benefits/catalog";
import type { ProgressInput } from "@/lib/benefits/progress";
import { syntheticCatalog } from "./helpers/benefit-catalog";
function setup(): ProgressInput {
  const card = syntheticCatalog().cards[0];
  return {
    catalog: engineProduct(card),
    account: {
      currency: "USD",
      product_id: card.id,
      anniversary: null,
      statement_close_day: null,
      tracking_start: null,
    },
    overrides: [],
    entries: [],
    as_of: "2026-06-15",
    view_year: 2026,
  };
}
function render(input: ProgressInput) {
  const card = syntheticCatalog().cards[0],
    progress = benefitProgress(input);
  const years = progress.instances.flatMap((instance) =>
    instance.status === "ok" && "year" in instance ? [instance.year] : [],
  );
  return renderToStaticMarkup(
    <BenefitProgressSection
      accountId="synthetic-card"
      catalog={{
        productId: card.id,
        productName: card.name,
        issuer: card.issuer,
        currency: card.currency,
        coverage: card.coverage,
        catalogVersion: "synthetic",
        sources: card.sources,
        annual: {
          used: sumMoney(years.map((year) => year.used)).toFixed(4),
          cap: sumMoney(years.map((year) => year.cap)).toFixed(4),
        },
        ...progress,
      }}
    />,
  );
}
it("renders full, partial, unused, upcoming and over-cap states from engine output", () => {
  for (const [amount, label] of [
    ["10", "已报销"],
    ["7", "部分报销"],
    ["12", "超出额度"],
  ]) {
    const input = setup();
    input.entries = [
      { id: "entry", date: "2026-06-01", amount, currency: "USD", description: "BEANHOUSE CREDIT" },
    ];
    const html = render(input);
    expect(html).toContain(label);
    expect(html).toContain("未报销");
    expect(html).toContain("未开始");
    expect(html).toContain("最近报销：");
    if (amount === "12") expect(html).toContain("请检查是否对应错误。");
  }
  expect(render(setup())).toContain("尚无报销");
});
it("renders multi-year usage and renewed eligibility without annualizing the window", () => {
  const input = setup();
  const version = input.catalog.credits[0].versions[0];
  version.period = "multi_year";
  version.period_years = 4;
  version.reset_basis = "since_last_credit";
  input.entries = [
    { id: "window", date: "2023-08-10", amount: "10", currency: "USD", description: "BEANHOUSE CREDIT" },
  ];
  const html = render(input);
  expect(html).toContain("已使用（2023-08-10），2027-08-10 起可再次使用");
  expect(html).toContain("每 4 年");
  expect(html).not.toContain("年度已报销");
  input.as_of = "2027-08-10";
  input.view_year = 2027;
  expect(render(input)).toContain("可使用");
});
