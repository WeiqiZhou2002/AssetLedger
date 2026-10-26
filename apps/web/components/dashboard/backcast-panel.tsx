"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { MoneyAmount } from "@/components/money-amount";
import { shiftDate } from "@/lib/bank-sync/date-range";
import type { BackcastSeries } from "@/lib/dashboard/backcast-core";
const Chart = dynamic(() => import("./backcast-chart").then((module) => module.BackcastChart), {
  ssr: false,
  loading: () => <p className="h-72 p-4 text-sm text-muted-foreground">加载回溯曲线…</p>,
});
export type BackcastData = BackcastSeries & { historyStart: string };
export function BackcastPanel({ series }: { series: BackcastData }) {
  const [range, setRange] = useState("history");
  const [showAssets, setShowAssets] = useState(false);
  const [showLiabilities, setShowLiabilities] = useState(false);
  const from = range === "history" ? series.historyStart : shiftDate(series.to, range === "90" ? -89 : -29);
  const days = series.days.filter((day) => day.date >= from);
  const last = days.at(-1);
  const fallback = [...new Set(days.flatMap((day) => day.fxFallbackAccounts.map((row) => row.name)))];
  const startLabel = `自 ${parseInt(series.historyStart.slice(5, 7), 10)}月${parseInt(series.historyStart.slice(8), 10)}日`;
  const hasValues = days.some((day) => day.netWorth !== null);
  return (
    <section
      className="min-w-0 space-y-4 rounded-2xl border bg-card p-4 sm:p-6"
      aria-label="净资产走势（按交易回溯）"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <h2 className="font-medium">净资产走势（按交易回溯）</h2>
          <p className="text-xs text-muted-foreground">
            {from} — {series.to} · 入账日期（缺失时用发生日期）
          </p>
        </div>
        <nav className="flex flex-wrap gap-1" aria-label="回溯时间范围">
          {[
            ["history", startLabel],
            ["90", "近 90 天"],
            ["30", "近 30 天"],
          ].map(([key, label]) => (
            <Button
              key={key}
              size="sm"
              variant={range === key ? "secondary" : "ghost"}
              aria-pressed={range === key}
              onClick={() => setRange(key)}
            >
              {label}
            </Button>
          ))}
        </nav>
      </div>
      {last?.netWorth !== null && last?.netWorth !== undefined ? (
        <div className="max-w-xs">
          <p className="mb-2 text-xs text-muted-foreground">
            {series.to} · 回溯估算{last.complete ? "" : "（未完全覆盖）"}
          </p>
          <MoneyAmount value={last.netWorth} currency={series.baseCurrency} />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
        <span className="font-medium text-primary">净资产</span>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={showAssets}
            onChange={(event) => setShowAssets(event.target.checked)}
          />
          资产
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={showLiabilities}
            onChange={(event) => setShowLiabilities(event.target.checked)}
          />
          负债
        </label>
      </div>
      {hasValues ? (
        <Chart
          days={days}
          currency={series.baseCurrency}
          showAssets={showAssets}
          showLiabilities={showLiabilities}
        />
      ) : (
        <p className="py-8 text-sm leading-7 text-muted-foreground">
          还没有可回溯的余额；请先
          <Link href="/accounts" className="text-primary underline">
            去账户页更新余额
          </Link>
          。证券需录入市值观察。
        </p>
      )}
      {series.observationOnlyAccounts.length ? (
        <p className="text-xs leading-6 text-muted-foreground">
          按余额观察（无流水）：{series.observationOnlyAccounts.map((account) => account.name).join("、")}
          。覆盖内延用最近一次观察；更早日期延用最早余额并标为估计。
        </p>
      ) : null}
      {fallback.length ? (
        <p className="text-xs leading-6 text-muted-foreground">
          部分日期缺少当日汇率，按锚点冻结或最早可用汇率估计：{fallback.join("、")}。
        </p>
      ) : null}
      <p className="text-xs leading-6 text-muted-foreground">
        按各账户最新观察和已确认流水逐日回溯；待入账、未审核或银行缺失的流水会影响准确性。证券沿用当日之前最近一次市值。
      </p>
    </section>
  );
}
