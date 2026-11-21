import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BenefitProgressSection } from "@/components/benefits/progress";
import { benefitProgress } from "@/lib/benefits/progress";
import { applyBenefitMarks, type BenefitMark } from "@/lib/benefits/marks";
import { creditYearReimbursed } from "@/lib/benefits/display";
import { matchBenefitCredits } from "@/lib/benefits/credit-match";
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
  return renderToStaticMarkup(
    <BenefitProgressSection
      accountId="synthetic-card"
      asOf={input.as_of}
      year={String(input.view_year)}
      catalog={{
        productId: card.id,
        productName: card.name,
        issuer: card.issuer,
        currency: card.currency,
        coverage: card.coverage,
        catalogVersion: "synthetic",
        sources: card.sources,
        reimbursed: Object.fromEntries(
          progress.instances.map((instance) => [
            instance.credit,
            creditYearReimbursed(instance, String(input.view_year), input.as_of),
          ]),
        ),
        credits: input.catalog.credits.map(({ id, name }) => ({ id, name })),
        entryAssignments: matchBenefitCredits(input).matches,
        ...progress,
      }}
    />,
  );
}
it("renders full, partial, unused, upcoming and over-cap states from engine output", () => {
  for (const [amount, label] of [
    ["10", "本期已用"],
    ["7", "本期部分使用"],
    ["12", "本期已用"],
  ]) {
    const input = setup();
    input.entries = [
      { id: "entry", date: "2026-06-01", amount, currency: "USD", description: "BEANHOUSE CREDIT" },
    ];
    const html = render(input);
    expect(html).toContain(label);
    expect(html).toContain("本期 2026-06-01 至 2026-06-30");
    expect(html).not.toMatch(/<details[^>]*\bopen/);
    if (amount === "12") expect(html).toContain("可能对应错误");
  }
  expect(render(setup())).toContain("本期未用");
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
  expect(html).toContain("2027-08-10 起可再次使用");
  expect(html).toContain("每 4 年");
  expect(html).not.toContain("年度已报销");
  input.as_of = "2027-08-10";
  input.view_year = 2027;
  expect(render(input)).toContain("可使用");
});

it("offers current-period marks only for unused/partial or already marked periods", () => {
  const input = setup();
  expect(render(input)).toContain("本期已报销</label>");
  expect(render(input).match(/type="checkbox"/g) ?? []).toHaveLength(1);
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
  expect(html).not.toContain("已手动标记");
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
  expect(html).not.toContain("已手动标记");
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
    expect(render(input)).toContain(kind === "estimated" ? "本期已用" : "已使用");
  },
);

it("describes an estimated rolling window without a deadline", () => {
  const input = setup();
  input.catalog.credits[0].versions[0].reset_basis = "anniversary";
  const html = render(input);
  expect(html).toContain("卡年度未知，按近 12 个月估算");
  expect(html).not.toContain("近 12 个月已报销");
  expect(html).not.toContain("剩余");
  expect(html).not.toContain("本期已报销");
  expect(html).not.toContain("截止");
});
it.each(["periodic", "estimated", "conditional-estimated"])(
  "hides current-period status and mark controls in past-year %s rows while retaining refunds",
  (kind) => {
    const input = setup();
    input.view_year = 2025;
    const version = input.catalog.credits[0].versions[0];
    if (kind !== "periodic") version.reset_basis = "anniversary";
    if (kind === "conditional-estimated") version.conditions = { consecutive_months: 3 };
    input.entries = [
      {
        id: "historical-refund",
        date: "2025-01-01",
        amount: "3",
        currency: "USD",
        description: "BEANHOUSE CREDIT",
      },
    ];
    const html = render(input);
    for (const text of [
      "本期已用",
      "本期部分使用",
      "本期未用",
      "本期 2025-",
      "卡年度未知，按近 12 个月估算",
      'type="checkbox"',
    ])
      expect(html).not.toContain(text);
    expect(html).toContain("/activity?entryId=historical-refund");
    expect(html).toContain("$3</span>");
    expect(html).toContain('aria-label="归属报销项目"');
  },
);

it("folds unreimbursed conditional credits and omits old progress and expired text", () => {
  const input = setup();
  input.catalog.credits[0].versions[0].conditions = {
    minimum_spend: { amount: "70", period: "benefit_period" },
  };
  const html = render(input);
  expect(html).toContain("其他报销项目 · 1 项");
  expect(html).toContain("需满足条件：本期消费满");
  expect(html).toContain("需满足条件</span>");
  expect(html).not.toContain("本期未用");
  expect(html).not.toMatch(/<details[^>]*\bopen/);
  expect(html.match(/type="checkbox"/g)).toHaveLength(1);
  for (const text of [
    "最多可报销",
    "已过期未用",
    "还可报销",
    "剩余",
    "另有需满足条件",
    "查看各周期明细",
    "最近报销",
    "暂无报销流水",
    "已手动标记",
    "条款核实于",
  ])
    expect(html).not.toContain(text);
});
it("lists only selected-year reimbursements through asOf, newest first and once each", () => {
  const input = setup();
  input.entries = [
    { id: "old", date: "2025-12-31", amount: "3", currency: "USD", description: "BEANHOUSE CREDIT" },
    { id: "first", date: "2026-01-01", amount: "3", currency: "USD", description: "BEANHOUSE CREDIT" },
    { id: "today", date: input.as_of, amount: "2", currency: "USD", description: "BEANHOUSE CREDIT" },
    { id: "future", date: "2026-06-16", amount: "3", currency: "USD", description: "BEANHOUSE CREDIT" },
  ];
  const html = render(input);
  expect(html).not.toContain("/activity?entryId=old");
  expect(html).not.toContain("/activity?entryId=future");
  expect(html.indexOf("/activity?entryId=today")).toBeLessThan(html.indexOf("/activity?entryId=first"));
  expect(html.match(/aria-label="归属报销项目"/g)).toHaveLength(2);
  expect(html).toContain('title="USD 5.00"');
  expect(html).toContain("$5</span>");
});
it("offers a credit assignment on each reimbursement entry", () => {
  const input = setup();
  input.entries = [
    {
      id: "synthetic-entry",
      date: "2026-06-01",
      amount: "3",
      currency: "USD",
      description: "BEANHOUSE CREDIT",
    },
  ];
  const html = render(input);
  expect(html).toContain('aria-label="归属报销项目"');
  expect(html).toContain("自动匹配（Coffee Credit）");
  expect(html).toContain('value="credit:coffee"');
  expect(html).toContain("不计入报销项目");
});
