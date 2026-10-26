import Link from "next/link";
import { InlineMoney, MoneyAmount } from "@/components/money-amount";
import { decimal } from "@/lib/money/fx";
import { CoverageNote, MonthPicker, type DashboardData } from "./personal-overview";
import { CurrentSpendingChart } from "./current-charts";
import { BackcastPanel } from "./backcast-panel";
import type { MonthActivity } from "@/lib/dashboard/activity";
const titles: Record<string, string> = {
  assets: "资产",
  liabilities: "负债",
  "net-worth": "净资产",
  spending: "支出",
  income: "收入",
};
export function DashboardDetails({
  wealth,
  month,
  backcast,
  view,
  activity,
}: DashboardData & { view: string; activity?: MonthActivity }) {
  const financial = view === "assets" || view === "liabilities";
  const rows = wealth.rows.filter((row) => row.side === (view === "assets" ? "asset" : "liability"));
  const summary = view === "income" ? month.income : month.spending;
  const href = (key: string, basis = month.basis) =>
    `/dashboard/details?view=${key}&month=${month.month}&basis=${basis}`;
  const activityHref = `/activity?from=${month.from}&to=${month.to}&basis=${month.basis}&view=${view}&status=confirmed`;
  return (
    <div className="min-w-0 space-y-6">
      <Link href={`/dashboard?month=${month.month}&basis=${month.basis}`} className="text-sm text-primary">
        ← 总览
      </Link>
      <h1 className="text-2xl font-medium">{titles[view]}</h1>
      <nav className="flex flex-wrap gap-4 text-sm">
        {Object.entries(titles).map(([key, label]) => (
          <Link
            key={key}
            href={href(key)}
            aria-current={view === key ? "page" : undefined}
            className={view === key ? "font-medium text-primary underline" : "text-muted-foreground"}
          >
            {label}
          </Link>
        ))}
      </nav>
      {financial ? (
        <>
          <CoverageNote wealth={wealth} />
          <div className="max-w-xl">
            {(view === "assets" ? wealth.assets : wealth.liabilities) === null ? (
              "未录入余额"
            ) : (
              <MoneyAmount
                value={(view === "assets" ? wealth.assets : wealth.liabilities)!}
                currency={wealth.baseCurrency}
                large
              />
            )}
          </div>
          {(view === "assets" ? ["现金存款", "投资", "其他"] : ["负债"]).map((group) => (
            <section key={group} className="rounded-xl border bg-card p-5">
              <h2 className="font-medium">{group}</h2>
              <ul className="mt-4 divide-y">
                {rows
                  .filter((row) => row.group === group)
                  .map((row) => (
                    <li
                      key={row.id}
                      className="grid min-w-0 gap-3 py-4 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)]"
                    >
                      <div className="min-w-0">
                        <Link
                          href={`/accounts#account-${row.accountIds[0]}`}
                          className="font-medium break-words text-primary"
                        >
                          {row.name}
                        </Link>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {row.source} · {row.date}
                          {row.stale ? " · 余额待更新" : ""}
                          {row.staleFx ? " · 汇率待更新" : ""}
                        </p>
                        <p className="mt-1 text-xs">
                          原币 <InlineMoney value={row.native} currency={row.currency} />
                          {decimal(row.native).lt(0)
                            ? row.side === "liability"
                              ? " · 溢缴"
                              : " · 透支 / 负余额"
                            : ""}
                        </p>
                      </div>
                      <div className="w-full max-w-xs min-w-0 sm:justify-self-end">
                        <p>
                          {row.value === null ? (
                            "缺少汇率，未计入"
                          ) : (
                            <MoneyAmount value={row.value} currency={wealth.baseCurrency} />
                          )}
                        </p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          占比 {row.share === null ? "—" : `${row.share}%`}
                        </p>
                      </div>
                    </li>
                  ))}
              </ul>
              {!rows.some((row) => row.group === group) ? (
                <p className="mt-4 text-sm text-muted-foreground">尚无可展示余额。</p>
              ) : null}
            </section>
          ))}
        </>
      ) : view === "net-worth" ? (
        <>
          <CoverageNote wealth={wealth} />
          <div className="rounded-xl border bg-card p-5 text-sm leading-8">
            资产{" "}
            {wealth.assets === null ? (
              "未录入"
            ) : (
              <InlineMoney value={wealth.assets} currency={wealth.baseCurrency} />
            )}{" "}
            − 负债{" "}
            {wealth.liabilities === null ? (
              "未录入"
            ) : (
              <InlineMoney value={wealth.liabilities} currency={wealth.baseCurrency} />
            )}{" "}
            = 净资产{" "}
            <strong>
              {wealth.netWorth === null ? (
                "未录入"
              ) : (
                <InlineMoney value={wealth.netWorth} currency={wealth.baseCurrency} />
              )}
            </strong>
          </div>
          <BackcastPanel series={backcast} />
        </>
      ) : (
        <>
          <MonthPicker month={month} path="/dashboard/details" view={view} />
          <div className="flex gap-4 text-xs">
            <Link
              className={month.basis === "posted" ? "text-primary" : "text-muted-foreground"}
              href={href(view, "posted")}
            >
              入账日期
            </Link>
            <Link
              className={month.basis === "event" ? "text-primary" : "text-muted-foreground"}
              href={href(view, "event")}
            >
              发生日期
            </Link>
          </div>
          <div className="max-w-xl">
            {summary.total === null ? (
              "缺少汇率"
            ) : (
              <MoneyAmount value={summary.total} currency={wealth.baseCurrency} large />
            )}
          </div>
          <p className="text-xs leading-6 text-muted-foreground">
            {month.from} → {month.to} · {summary.count} 笔已确认流水 ·
            按交易当日汇率折算；退款与权益返还抵减支出，转账清算不计收支。
          </p>
          {summary.missingFx.length ? (
            <p className="text-xs text-amber-800">缺少汇率，已排除：{summary.missingFx.join("、")}</p>
          ) : null}
          {summary.staleFx.length ? (
            <p className="text-xs text-amber-800">使用较旧汇率：{summary.staleFx.join("、")}</p>
          ) : null}
          <section className="rounded-xl border bg-card p-5">
            <h2 className="font-medium">按分类 · 净额占比</h2>
            <ul className="mt-4 divide-y">
              {summary.categories.map((row) => (
                <li
                  key={row.categoryId ?? "none"}
                  className="flex flex-wrap justify-between gap-3 py-3 text-sm"
                >
                  <Link
                    className="text-primary"
                    href={`${activityHref}${row.categoryId ? `&categoryId=${row.categoryId}` : ""}`}
                  >
                    {row.category}
                  </Link>
                  <span>
                    <InlineMoney value={row.amount} currency={wealth.baseCurrency} /> ·{" "}
                    {row.share === null ? "—" : `${row.share}%`}
                  </span>
                </li>
              ))}
            </ul>
            {!summary.count ? (
              <p className="mt-5 text-sm text-muted-foreground">所选月份尚无已确认{titles[view]}。</p>
            ) : null}
          </section>
          <section aria-label="本月流水" className="min-w-0 rounded-xl border bg-card p-5">
            <h2 className="font-medium">本月流水</h2>
            <p className="mt-2 text-xs text-muted-foreground">逐笔显示原币金额，退款为负数。</p>
            <ul className="mt-3 divide-y">
              {activity?.entries.map((entry) => (
                <li key={entry.id} className="min-w-0">
                  <Link
                    href={`/activity?entryId=${entry.id}`}
                    className="block min-w-0 space-y-2 rounded py-3 text-sm hover:bg-muted/50"
                  >
                    <span className="block truncate text-primary" title={entry.description ?? undefined}>
                      {entry.description || entry.categories.join("、")}
                    </span>
                    <span className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                      <span className="min-w-0 break-words">
                        {entry.date} · {entry.categories.join("、")}
                      </span>
                      <span className="flex flex-wrap gap-x-3">
                        {Object.entries(entry.amounts).map(([currency, amount]) => (
                          <InlineMoney key={currency} value={amount} currency={currency} />
                        ))}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {!activity?.entries.length ? (
              <p className="my-4 text-sm text-muted-foreground">所选月份尚无已确认{titles[view]}流水。</p>
            ) : null}
            {activity && activity.total > activity.entries.length ? (
              <p className="my-3 text-xs text-muted-foreground">显示最近 100 笔，共 {activity.total} 笔。</p>
            ) : null}
            <Link className="mt-3 block text-sm text-primary" href={activityHref}>
              在流水中查看全部 →
            </Link>
          </section>
          {view === "spending" && summary.count ? (
            <section className="min-w-0 rounded-xl border bg-card p-5">
              <h2 className="mb-4 font-medium">每日支出</h2>
              <CurrentSpendingChart rows={summary.daily} currency={wealth.baseCurrency} />
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
