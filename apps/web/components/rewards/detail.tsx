"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { FormSheet } from "@/components/ledger/forms";
import { formatAmount } from "@/lib/ledger/format";
import { eventLabels } from "@/lib/rewards/constants";
import type { RewardsOverview } from "@/lib/rewards/queries";
import type { RewardForm } from "./forms";
import { DeleteRewardAccount } from "./delete-account";
const Chart = dynamic(() => import("./chart"), {
  ssr: false,
  loading: () => <div className="h-72 animate-pulse rounded-xl bg-muted" />,
});
export function RewardDetail({
  account,
  onClose,
  onEdit,
}: {
  account: RewardsOverview["accounts"][number];
  onClose: () => void;
  onEdit: (form: RewardForm) => void;
}) {
  const decomposition = account.decomposition;
  return (
    <FormSheet
      title={account.name}
      description={`${account.program.name} · 日终观察之后的事件推算余额`}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="mt-5 space-y-6">
        <p className="text-3xl font-medium break-all tabular-nums">
          {BigInt(account.points).toLocaleString()}{" "}
          <span className="text-sm text-muted-foreground">{account.program.unitLabel}</span>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onEdit({ kind: "event", accountId: account.id })}>
            记录变动
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onEdit({ kind: "observation", accountId: account.id })}
          >
            录入观察
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onEdit({ kind: "account", account })}>
            编辑账户
          </Button>
        </div>
        <section>
          <h3 className="text-sm font-medium">点数与参考估值 · 近 30 天</h3>
          <Chart rows={account.chart} />
          {decomposition ? (
            <div className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
              {(["baseline", "personal"] as const).map((basis) => (
                <div key={basis} className="rounded-xl bg-muted p-4 leading-6">
                  <h4 className="font-medium">{basis === "baseline" ? "基准" : "个人"}估值变化</h4>
                  <p>数量影响 {formatAmount(decomposition[basis].quantityEffect, "USD")}</p>
                  <p>CPP 影响 {formatAmount(decomposition[basis].cppEffect, "USD")}</p>
                  <p className="border-t pt-1">
                    合计 {formatAmount(decomposition[basis].totalChange, "USD")}
                  </p>
                </div>
              ))}
            </div>
          ) : null}
          <p className="mt-3 text-xs leading-6 text-muted-foreground">
            数量影响 = 点数变化 × 期初 CPP ÷ 100；CPP 影响 = 期末点数 × CPP 变化 ÷ 100。
          </p>
        </section>
        <section>
          <h3 className="mb-3 font-medium">观察与积分对账</h3>
          {account.reconciliation.length ? (
            <ul className="divide-y">
              {account.reconciliation.map((row) => (
                <li key={row.id} className="py-3 text-xs leading-6">
                  <p>
                    {row.observedOn} · 观察 {row.balance} 点
                  </p>
                  <p
                    className={
                      row.difference && row.difference !== "0" ? "text-amber-900" : "text-muted-foreground"
                    }
                  >
                    {row.expected === null
                      ? "首份观察，作为日终起点"
                      : `预期 ${row.expected} − 观察 ${row.balance} = 差额 ${row.difference} 点`}
                  </p>
                  {row.expected !== null ? (
                    <p className="text-muted-foreground">
                      前次观察 + 区间内 {row.eventIds.length} 条事件；差额不自动补记。
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">尚无观察，余额从零累计事件。</p>
          )}
        </section>
        <section>
          <h3 className="mb-3 font-medium">积分事件</h3>
          {account.events.length ? (
            <ul className="divide-y">
              {[...account.events].reverse().map((event) => (
                <li key={event.id} className="py-3 text-sm">
                  <div className="flex justify-between gap-3">
                    <span>{eventLabels[event.type]}</span>
                    <span className="font-mono">
                      {BigInt(event.pointsDelta) > 0n ? "+" : ""}
                      {event.pointsDelta}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {event.eventDate} ·{" "}
                    {event.source === "statement"
                      ? "账单确认"
                      : event.source === "legacy"
                        ? "历史迁移"
                        : "手工"}
                    {event.transferId ? ` · 转点 ${event.transferId.slice(0, 8)}` : ""}
                  </p>
                  {event.note ? <p className="mt-2 text-xs">{event.note}</p> : null}
                  {event.relatedJournalEntryId ? (
                    <Link
                      className="text-xs text-primary"
                      href={`/activity?entryId=${event.relatedJournalEntryId}`}
                    >
                      查看说明性流水关联
                    </Link>
                  ) : null}
                  {event.statementId ? (
                    <Link className="text-xs text-primary" href={`/statements/${event.statementId}`}>
                      查看来源账单
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">尚无积分变动。</p>
          )}
        </section>
        <section>
          <h3 className="mb-3 font-medium">CPP 历史（美分 / 点）</h3>
          {[...account.cppHistory].reverse().map((cpp) => (
            <p key={cpp.id} className="border-b py-3 text-xs">
              {cpp.effectiveDate} · 基准 {cpp.cppBaseline} · 个人 {cpp.cppPersonal} ·{" "}
              {cpp.source === "default" ? "默认" : "自定义"}
            </p>
          ))}
        </section>
        <DeleteRewardAccount accountId={account.id} onDeleted={onClose} />
      </div>
    </FormSheet>
  );
}
