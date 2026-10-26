"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, SelectField, FormError, FormSheet, api, useLedgerMutation } from "@/components/ledger/forms";
import type { planBackfill } from "@/lib/bank-sync/backfill";
import type { BackfillAction } from "@/lib/bank-sync/backfill-types";
import type { SyncCounts } from "@/lib/bank-sync/run-counts";
import type { ResetCounts } from "@/lib/bank-sync/reset-types";

import { formatSyncTime } from "@/lib/bank-sync/time-format";

type Plan = Awaited<ReturnType<typeof planBackfill>>;
export function SyncRunSummary({
  run,
  timezone,
}: {
  run: {
    counts: SyncCounts & Partial<ResetCounts>;
    kind?: string;
    jobId?: string | null;
    effectiveFromDate: string;
    status: string;
    startedAt: string | Date;
    finishedAt: string | Date | null;
  };
  timezone: string;
}) {
  const c = run.counts;
  return (
    <div className="space-y-2 text-xs leading-6">
      <p className="text-muted-foreground">
        最近运行：{formatSyncTime(run.finishedAt ?? run.startedAt, timezone)}
      </p>
      {run.kind === "reset" ? (
        <p>
          已重置 {c.entries_deleted ?? 0} 笔流水 / {c.rows_deleted ?? 0} 条导入记录，
          {run.jobId ? "重新同步已排队" : "完成账户映射后开始同步"} · 生效起始日 {run.effectiveFromDate}
        </p>
      ) : (
        <p>
          拉取 {c.fetched_added + c.fetched_modified + c.fetched_removed} · 新增 {c.imported} ·
          早于起始日期跳过 {c.before_start_skipped} · 待入账跳过 {c.pending_skipped}
          {(c.core_sweep_skipped ?? 0) > 0 ? (
            <> · 忽略 Fidelity SPAXX 核心仓位申赎 {c.core_sweep_skipped}</>
          ) : null}{" "}
          · 生效起始日 {run.effectiveFromDate}
        </p>
      )}
      {run.status === "failed" ? (
        <p role="alert" className="rounded-lg bg-amber-50 p-3 text-amber-950">
          同步未完成。请核对连接状态和期初余额是否被编辑，重新预览补导或重试同步。
        </p>
      ) : null}
      {c.imported === 0 && c.before_start_skipped > 0 ? (
        <p role="alert" className="rounded-lg bg-amber-50 p-3 text-amber-950">
          本次未新增流水，历史记录被起始日期过滤。可先预览“补导历史流水”，核对已有期初。
        </p>
      ) : null}
    </div>
  );
}
export function BackfillForm({ connectionId, fromDate }: { connectionId: string; fromDate: string }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(fromDate);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [actions, setActions] = useState<Record<string, BackfillAction>>({});
  const mutation = useLedgerMutation();
  const payload = {
    from,
    actions: Object.entries(actions).map(([accountId, action]) => ({ accountId, action })),
  };
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        补导历史流水
      </Button>
      <FormSheet
        open={open}
        onOpenChange={setOpen}
        title="补导历史流水"
        description="先预览已有流水与期初；不会删除或重新连接银行。"
      >
        <div className="space-y-4">
          <p className="text-sm leading-6">
            只能取回 Plaid
            已持有的历史；扩大窗口不保证银行提供更早数据。投资交易不在范围内，券商现金历史仅在该连接支持
            Transactions 时可用。
          </p>
          <Field
            label="补导起始日期"
            type="date"
            value={from}
            max={fromDate}
            onChange={(event) => {
              setFrom(event.target.value);
              setPlan(null);
              setActions({});
            }}
          />
          <Button
            variant="outline"
            disabled={mutation.pending}
            onClick={() =>
              void mutation.run(async () => {
                setPlan(await api<Plan>(`/api/plaid/connections/${connectionId}/backfill`, "POST", payload));
              })
            }
          >
            预览补导计划
          </Button>
          {plan ? (
            <div className="space-y-4">
              <p className="text-sm">
                {plan.currentFromDate} → {plan.targetFromDate} · 排队/运行任务 {plan.jobs.length}{" "}
                个（执行时旧任务将失效）
              </p>
              <p className="text-xs text-muted-foreground">
                {plan.transactionsAvailable ? (
                  <>Plaid 可提供的历史起点 ≈ {plan.availabilityStart}；更早流水请上传 PDF/CSV。</>
                ) : (
                  "此连接不提供交易流水，仅同步余额/持仓"
                )}
              </p>
              {plan.currentFromDate === plan.targetFromDate ? (
                <p className="text-xs text-muted-foreground">
                  当前起点已不晚于默认历史起点，没有更早的区间需要补导；执行将重放现有窗口。
                </p>
              ) : null}
              {plan.accounts.map((account) => (
                <div key={account.accountId} className="space-y-2 rounded-lg border p-3 text-sm leading-6">
                  <p className="font-medium">
                    {account.name}
                    {!account.enabled ? " · 已停用" : ""}
                  </p>
                  <p>
                    已有流水：手工 {account.entries.manual} / PDF {account.entries.pdf} / CSV{" "}
                    {account.entries.csv} / Plaid {account.entries.plaid}；待处理 {account.pending}
                  </p>
                  <p>
                    有效期初：
                    {account.openings
                      .map((entry) => `${entry.date}（${entry.status === "draft" ? "草稿" : "已确认"}）`)
                      .join("、") || "无"}
                  </p>
                  <SelectField
                    label="账户处理"
                    value={actions[account.accountId] ?? "keep"}
                    onChange={(event) =>
                      setActions((current) => ({
                        ...current,
                        [account.accountId]: event.target.value as BackfillAction,
                      }))
                    }
                  >
                    <option value="keep">保留期初，仅补导期初之后（默认）</option>
                    {account.conflict && account.openings.length === 1 && account.enabled ? (
                      <option value="recalculate">重算期初：历史完成后作废并替换</option>
                    ) : null}
                    <option value="exclude">排除此账户（停用同步）</option>
                  </SelectField>
                  {(actions[account.accountId] ?? "keep") === "keep" ? (
                    <p className="text-xs text-muted-foreground">生效起始日 {account.effectiveFromDate}</p>
                  ) : null}
                </div>
              ))}
              <p className="text-xs leading-6 text-muted-foreground">
                导入行数为零不代表账本为空。重算期初使用已发布余额减全部来源的已确认流水（不含旧期初）；有待审核行时延后重算。银行待处理交易可能造成差异，请核对银行。
              </p>
              <Button
                disabled={mutation.pending}
                onClick={() =>
                  void mutation.run(async () => {
                    await api(`/api/plaid/connections/${connectionId}/backfill`, "POST", {
                      ...payload,
                      execute: true,
                    });
                    setOpen(false);
                    setPlan(null);
                  }, "补导已排队，历史同步完成后按选择处理期初")
                }
              >
                确认执行补导
              </Button>
            </div>
          ) : null}
          <FormError error={mutation.error} />
        </div>
      </FormSheet>
    </>
  );
}
