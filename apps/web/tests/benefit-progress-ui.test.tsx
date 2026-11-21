import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BenefitProgressSection } from "@/components/benefits/progress";
import { InlineMoney } from "@/components/money-amount";
import { benefitProgress } from "@/lib/benefits/progress";
import { applyBenefitMarks, type BenefitMark } from "@/lib/benefits/marks";
import { benefitTotals } from "@/lib/benefits/totals";
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
      catalog={{
        productId: card.id,
        productName: card.name,
        issuer: card.issuer,
        currency: card.currency,
        coverage: card.coverage,
        catalogVersion: "synthetic",
        sources: card.sources,
        annual: benefitTotals(progress.instances),
        credits: input.catalog.credits.map(({ id, name }) => ({ id, name })),
        entryAssignments: matchBenefitCredits(input).matches,
        ...progress,
      }}
    />,
  );
}
function disclosure(html: string, label: string) {
  const block = (html.match(/<details\b[\s\S]*?<\/details>/g) ?? []).find((block) =>
    block.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/)?.[1].startsWith(label),
  );
  expect(block).toBeDefined();
  return block!;
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

it("keeps expired periods and removable past marks in separate disclosures with one checkbox per period", () => {
  const input = setup();
  const html = render(input, [
    {
      catalogProductId: input.catalog.id,
      creditId: "coffee",
      periodStart: "2026-02-01",
      periodEnd: "2026-02-28",
    },
  ]);
  const details = disclosure(html, "查看各周期明细");
  expect(details).not.toContain('type="checkbox"');
  expect(details).toContain("查看各周期明细（2026-01-01 至 2026-12-31）");
  const expired = disclosure(html, "已过期未用");
  expect(expired).toContain("已过期未用 · 4 个周期 · 共 ");
  expect(expired).toContain(renderToStaticMarkup(<InlineMoney value="40.0000" currency="USD" />));
  expect(expired.match(/type="checkbox"/g)).toHaveLength(4);
  const marked = disclosure(html, "已手动标记");
  expect(marked).toContain("已手动标记 · 1 个周期");
  expect(marked.match(/type="checkbox"/g)).toHaveLength(1);
  expect(html.match(/type="checkbox"/g)).toHaveLength(6);
  expect(html.match(/checked=""/g)).toHaveLength(1);
  expect(html).toContain("2026 年额度");
  expect(html).toContain("还可报销");
});
it.each([
  ["2026-02-15", 1, "7.5000", true],
  ["2026-04-15", 3, "27.5000", true],
  ["2026-05-15", 4, "37.5000", false],
  ["2026-10-15", 9, "87.5000", false],
] as const)("summarizes expired periods on %s and expands only short lists", (asOf, count, total, open) => {
  const input = setup();
  input.as_of = asOf;
  input.entries = [
    { id: "partial", date: "2026-01-02", amount: "2.50", currency: "USD", description: "BEANHOUSE CREDIT" },
  ];
  const html = render(input);
  const expired = disclosure(html, "已过期未用");
  expect(/<details\b[^>]*\bopen=""/.test(expired)).toBe(open);
  const summary = expired.match(/<summary\b[^>]*>[\s\S]*?<\/summary>/)![0];
  expect(summary).toContain("text-destructive");
  expect(summary).toContain(`已过期未用 · ${count} 个周期 · 共 `);
  expect(summary).toContain(renderToStaticMarkup(<InlineMoney value={total} currency="USD" />));
  const rows = expired.match(/<li\b[\s\S]*?<\/li>/g) ?? [];
  expect(rows).toHaveLength(count);
  for (const row of rows) expect(row.match(/type="checkbox"/g)).toHaveLength(1);
  expect(html.match(/type="checkbox"/g)).toHaveLength(count + 1);
});
it.each([
  ["2026-02-15", 1, true],
  ["2026-04-15", 3, true],
  ["2026-05-15", 4, false],
  ["2026-10-15", 9, false],
] as const)("summarizes removable past marks on %s and expands only short lists", (asOf, count, open) => {
  const input = setup();
  input.as_of = asOf;
  const instance = benefitProgress(input).instances[0];
  if (instance.status !== "ok" || !("year" in instance)) throw new Error("Expected periodic credit");
  const marks = instance.periods
    .filter((period) => period.end < asOf)
    .map((period) => ({
      catalogProductId: input.catalog.id,
      creditId: instance.credit,
      periodStart: period.start,
      periodEnd: period.end,
    }));
  const html = render(input, marks);
  const marked = disclosure(html, "已手动标记");
  expect(/<details\b[^>]*\bopen=""/.test(marked)).toBe(open);
  expect(marked).toContain(`已手动标记 · ${count} 个周期</summary>`);
  const rows = marked.match(/<li\b[\s\S]*?<\/li>/g) ?? [];
  expect(rows).toHaveLength(count);
  for (const row of rows) {
    expect(row.match(/type="checkbox"/g)).toHaveLength(1);
    expect(row).toContain('checked=""');
  }
  expect(html).not.toMatch(/<summary\b[^>]*>已过期未用/);
  expect(html.match(/type="checkbox"/g)).toHaveLength(count + 1);
});
it("labels unqualified conditional credits without showing expired-unused amounts or past checkboxes", () => {
  const input = setup();
  input.catalog.credits[0].versions[0].conditions = {
    minimum_spend: { amount: "70", period: "benefit_period" },
  };
  const html = render(input);
  expect(html).toContain("需满足条件</span>");
  expect(html).toContain("满足条件后可用");
  expect(html).not.toContain("已过期未用");
  expect(html.match(/type="checkbox"/g)).toHaveLength(1);
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
