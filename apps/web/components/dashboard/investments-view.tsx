"use client";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Badge } from "@/components/ui/badge";
import { formatAmount } from "@/lib/ledger/format";
import type { snapshotAnalytics } from "@/lib/snapshots/analytics";
type Insights = Awaited<ReturnType<typeof snapshotAnalytics>>;
const MarketHistoryChart = dynamic(() => import("./charts").then((module) => module.MarketHistoryChart), {
  ssr: false,
  loading: () => <div className="h-52 animate-pulse rounded-xl bg-muted" />,
});
export function InvestmentsView({ rows, today }: { rows: Insights["investments"]; today: string }) {
  return (
    <div className="space-y-6">
      {rows.length ? (
        rows.map((row) => (
          <section key={row.id} className="min-w-0 rounded-2xl border bg-card p-5 sm:p-7">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-medium">
                {row.name} · {row.currency}
              </h2>
              <Badge variant={row.stale ? "outline" : "secondary"}>
                {row.stale ? "市值待更新" : "近期观察"}
              </Badge>
            </div>
            <div className="my-6 grid gap-5 sm:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground">
                  最近观察市值 · {row.observations[0]?.date ?? "未记录"}
                </p>
                <p className="mt-2 font-mono text-xl">
                  {row.observations[0] ? formatAmount(row.observations[0].value, row.currency) : "待录入"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">账本净投入 · {today}</p>
                <p className="mt-2 font-mono text-xl">{formatAmount(row.netInvested, row.currency)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">最近两次观察间市场变化</p>
                <p className="mt-2 font-mono text-xl">
                  {row.marketChange !== null ? formatAmount(row.marketChange, row.currency) : "需要两次观察"}
                </p>
              </div>
            </div>
            <p className="mb-5 text-xs leading-6 text-muted-foreground">
              市场变化 = 期末市值 − 期初市值 −
              期间证券净流入。账本净投入只包含已记录分录，不用余额观察反推缺失的历史交易。
            </p>
            {row.observations.length ? (
              <>
                <MarketHistoryChart rows={[...row.observations].reverse()} currency={row.currency} />
                <details className="mt-4">
                  <summary className="cursor-pointer text-xs">观察记录与来源</summary>
                  <div className="mt-3 space-y-2">
                    {row.observations.map((point) => (
                      <p key={point.snapshotId} className="flex flex-wrap justify-between gap-3 text-xs">
                        <span>{point.date}</span>
                        <span className="font-mono">{formatAmount(point.value, row.currency)}</span>
                      </p>
                    ))}
                  </div>
                </details>
              </>
            ) : (
              <p className="py-6 text-sm text-muted-foreground">尚未记录证券市值，曲线保持为空。</p>
            )}
            <Link href="/accounts" className="mt-5 inline-block text-sm text-primary">
              去账户页更新市值 →
            </Link>
          </section>
        ))
      ) : (
        <section className="rounded-xl border bg-card p-8">
          <p className="text-sm leading-7">先新增证券账户，再在账户详情更新市值。</p>
          <Link href="/accounts" className="mt-4 inline-block text-sm text-primary">
            新增账户 →
          </Link>
        </section>
      )}
    </div>
  );
}
