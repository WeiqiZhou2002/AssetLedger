import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BenefitProgressSection } from "@/components/benefits/progress";
import { benefitProgress } from "@/lib/benefits/progress";
import { applyBenefitMarks, type BenefitMark } from "@/lib/benefits/marks";
import { sumMoney } from "@/lib/money";
import { engineProduct } from "@/lib/benefits/catalog";
import type { ProgressInput } from "@/lib/benefits/progress";
import { syntheticCatalog } from "./helpers/benefit-catalog";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
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
function render(input: ProgressInput, marks: BenefitMark[] = []) {
  const card = syntheticCatalog().cards[0],
    engine = benefitProgress(input),
    progress = { ...engine, instances: applyBenefitMarks(engine.instances, marks, card.id, input.as_of) };
  const years = progress.instances.flatMap((instance) =>
    instance.status === "ok" && "year" in instance ? [instance.year] : [],
  );
  return renderToStaticMarkup(
    <BenefitProgressSection
      accountId="synthetic-card"
      asOf={input.as_of}
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
  expect(render(setup())).toContain("暂无报销流水");
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

it("offers current and past-period marks only for unused/partial or already marked periods", () => {
  const input = setup();
  expect(render(input)).toContain("本期已报销</label>");
  expect(render(input).match(/type="checkbox"/g) ?? []).toHaveLength(6);
  for (const amount of ["10", "12"]) {
    input.entries = [
      { id: "entry", date: "2026-06-01", amount, currency: "USD", description: "BEANHOUSE CREDIT" },
    ];
    expect(render(input)).not.toContain("本期已报销</label>");
  }
  const mark = {
    catalogProductId: input.catalog.id,
    creditId: "coffee",
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
  };
  const html = render(input, [mark]);
  expect(html).toContain("已手动标记");
  expect(html).toContain("本期已报销</label>");
  expect(html).toContain('checked=""');
  const adjusted = applyBenefitMarks(
    benefitProgress(input).instances,
    [mark],
    input.catalog.id,
    input.as_of,
  )[0];
  expect(adjusted).toMatchObject({
    current_period: { state: "over", used: "12.0000", detected_used: "12.0000", remaining: "0.0000" },
  });
});
it.each(["to_verify", "unsupported", "informational"])("has no checkbox for %s", (kind) => {
  const input = setup(),
    credit = input.catalog.credits[0];
  if (kind === "to_verify") credit.versions[0].status = "to_verify";
  else if (kind === "unsupported") credit.versions[0].period = "future";
  else credit.delivery = "issuer_wallet";
  expect(render(input)).not.toContain('type="checkbox"');
});
it.each(["estimated", "multi_year"])("renders one checkbox and removable active mark for %s", (kind) => {
  const input = setup(),
    version = input.catalog.credits[0].versions[0];
  if (kind === "estimated") version.reset_basis = "anniversary";
  else Object.assign(version, { period: "multi_year", period_years: 4, reset_basis: "since_last_credit" });
  expect(render(input).match(/type="checkbox"/g) ?? []).toHaveLength(1);
  const html = render(input, [
    {
      catalogProductId: input.catalog.id,
      creditId: "coffee",
      periodStart: input.as_of,
      periodEnd: "2027-06-14",
    },
  ]);
  expect(html).toContain('checked=""');
  expect(html).toContain("已手动标记");
  expect(html).not.toContain('type="date"');
  expect(html).not.toContain("/accounts#");
});
it("ignores inactive marks and clamps over-cap estimates without changing the engine", () => {
  const input = setup();
  input.catalog.credits[0].versions[0].reset_basis = "anniversary";
  input.entries = [
    { id: "entry", date: "2026-06-01", amount: "12", currency: "USD", description: "BEANHOUSE CREDIT" },
  ];
  const engine = benefitProgress(input),
    before = structuredClone(engine);
  const adjusted = applyBenefitMarks(
    engine.instances,
    [
      {
        catalogProductId: input.catalog.id,
        creditId: "coffee",
        periodStart: "2025-01-01",
        periodEnd: "2025-12-31",
      },
    ],
    input.catalog.id,
    input.as_of,
  );
  expect(adjusted[0]).toMatchObject({
    status: "estimated",
    window: { used: "12.0000", remaining: "0.0000" },
  });
  expect(adjusted[0].marked).toBeUndefined();
  expect(engine).toEqual(before);
});

it.each(["estimated", "multi_year"])(
  "hides the checkbox when %s was already detected as reimbursed",
  (kind) => {
    const input = setup(),
      version = input.catalog.credits[0].versions[0];
    if (kind === "estimated") version.reset_basis = "anniversary";
    else Object.assign(version, { period: "multi_year", period_years: 4, reset_basis: "since_last_credit" });
    input.entries = [
      { id: "entry", date: "2026-06-01", amount: "10", currency: "USD", description: "BEANHOUSE CREDIT" },
    ];
    expect(render(input)).not.toContain('type="checkbox"');
    expect(render(input)).toContain("已报销");
  },
);

it("describes an estimated rolling window without a deadline", () => {
  const input = setup();
  input.catalog.credits[0].versions[0].reset_basis = "anniversary";
  const html = render(input);
  expect(html).toContain("按卡年度重置，暂按近 12 个月估算");
  expect(html).toContain("近 12 个月已报销");
  expect(html).toContain("剩余");
  expect(html).not.toContain("本期已报销");
  expect(html).not.toContain("截止");
});
