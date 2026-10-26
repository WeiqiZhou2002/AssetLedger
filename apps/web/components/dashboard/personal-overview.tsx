import { BackcastPanel, type BackcastData } from "./backcast-panel";
import Link from "next/link";
import type { wealthOverview } from "@/lib/dashboard/wealth";
import type { monthSummary } from "@/lib/dashboard/month";
import { MoneyAmount } from "@/components/money-amount";
export type DashboardData = {
  dueBalanceCount?: number;
  backcast: BackcastData;
  wealth: Awaited<ReturnType<typeof wealthOverview>>;
  month: Awaited<ReturnType<typeof monthSummary>>;
};
export function MonthPicker({
  month,
  path = "/dashboard",
  view,
}: {
  month: DashboardData["month"];
  path?: string;
  view?: string;
}) {
  const href = (value: string) => `${path}?month=${value}&basis=${month.basis}${view ? `&view=${view}` : ""}`;
  return (
    <nav
      aria-label="统计月份"
      className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card p-4 text-sm"
    >
      <Link href={href(month.previous)} className="py-1 text-primary" aria-label="上一个月">
        ← 上月
      </Link>
      <span className="font-medium tabular-nums">{month.month}</span>
      <Link href={href(month.next)} className="py-1 text-primary" aria-label="下一个月">
        下月 →
      </Link>
    </nav>
  );
}
export function CoverageNote({ wealth }: Pick<DashboardData, "wealth">) {
  const missing = wealth.excluded.filter((row) => row.reason.startsWith("未录入"));
  return (
    <div className="space-y-2 text-xs leading-6 text-muted-foreground">
      <p>
        按各账户最新余额 · 所有币种折算 {wealth.baseCurrency} ·
        观察日期可能不同。已有期初且无观察的非证券账户使用账本推算。
      </p>
      {missing.length ? (
        <p className="text-amber-800">
          {missing.length} 个账户未录入余额（证券需市值），暂未计入：
          {missing.map((row) => row.name).join("、")}。
          <Link href="/accounts" className="underline">
            去账户页更新余额 →
          </Link>
        </p>
      ) : null}
      {wealth.excluded
        .filter((row) => !row.reason.startsWith("未录入"))
        .map((row) => (
          <p key={row.id} className="text-amber-800">
            {row.name}：{row.reason}
          </p>
        ))}
      {wealth.missingFx.length ? (
        <p className="text-amber-800">
          缺少汇率，已排除：{wealth.missingFx.join("、")}。
          <Link href="/settings" className="underline">
            补充汇率 →
          </Link>
        </p>
      ) : null}
    </div>
  );
}
export function PersonalOverview({ wealth, month, backcast, dueBalanceCount = 0 }: DashboardData) {
  const kpis = [
    ["assets", "资产", wealth.assets],
    ["liabilities", "负债", wealth.liabilities],
    ["net-worth", "净资产", wealth.netWorth],
    ["spending", "本月支出", month.spending.total],
    ["income", "本月收入", month.income.total],
  ] as const;
  return (
    <div className="min-w-0 space-y-6">
      <header>
        <p className="eyebrow">ASSET LEDGER</p>
        <h1 className="mt-3 text-3xl font-medium">我有多少钱</h1>
        <p className="mt-3 text-sm text-muted-foreground">余额截至 {wealth.today} · 点开数字查看明细</p>
      </header>
      <section
        aria-label="资产与收支"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3"
      >
        {kpis.map(([key, label, value]) => (
          <Link
            key={key}
            href={`/dashboard/details?view=${key}&month=${month.month}&basis=${month.basis}`}
            className={`min-w-0 rounded-2xl p-5 transition-shadow hover:shadow-md sm:p-6 ${key === "net-worth" ? "row-start-1 bg-primary text-primary-foreground sm:col-span-2 lg:col-span-1 lg:col-start-3" : "border bg-card"}`}
          >
            <h2 className={`text-sm ${key === "net-worth" ? "opacity-80" : "text-muted-foreground"}`}>
              {label}
            </h2>
            <div className="mt-4">
              {value === null ? (
                <p className="text-sm">未录入余额 / 汇率</p>
              ) : (
                <MoneyAmount value={value} currency={wealth.baseCurrency} large={key === "net-worth"} />
              )}
            </div>
            <p className="mt-4 text-xs opacity-70">
              {key === "net-worth"
                ? "资产 − 负债"
                : key === "spending"
                  ? "退款抵减，不含转账"
                  : key === "income"
                    ? "不含权益返还"
                    : "最新余额"}{" "}
              · 查看 →
            </p>
          </Link>
        ))}
      </section>
      {dueBalanceCount > 0 ? (
        <p className="text-sm">
          <Link href="/accounts" className="text-primary">
            {dueBalanceCount} 个账户需要更新余额 → 账户
          </Link>
        </p>
      ) : null}
      <BackcastPanel series={backcast} />
      <CoverageNote wealth={wealth} />
      {[...new Set([...month.spending.missingFx, ...month.income.missingFx])].length ? (
        <p className="text-xs text-amber-800">本月收支有缺失汇率，合计仅含可换算流水；请在明细核对。</p>
      ) : null}
    </div>
  );
}
