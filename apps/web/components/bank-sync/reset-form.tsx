"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormError, FormSheet, api, useLedgerMutation } from "@/components/ledger/forms";
import type { planReset, executeReset } from "@/lib/bank-sync/reset";
type Plan = Awaited<ReturnType<typeof planReset>>;
type Result = Awaited<ReturnType<typeof executeReset>>;
export function ResetPreview({ plan, names }: { plan: Plan; names: Record<string, string> }) {
  const c = plan.totals;
  return (
    <div className="space-y-4 text-sm leading-7">
      <div className="rounded-lg border bg-muted/40 p-4">
        <p>
          将删除 {c.entries_deleted} 笔流水 / {c.postings_deleted} 条分录明细 / {c.rows_deleted} 条导入记录 /{" "}
          {c.containers_deleted} 份 Plaid 收件箱记录。
        </p>
        <p>
          待处理 {c.pending_deleted} 项 · 解除转账关联 {c.transfer_links_unlinked} 个 · 清除退款关联{" "}
          {c.refund_links_cleared} 个 · 移除购物组关联 {c.purchase_group_links_removed} 个。
        </p>
        <p>
          建议期初：删除 {c.suggested_openings_deleted} 笔，保留 {c.suggested_openings_kept} 笔；其他期初保留{" "}
          {c.other_openings_kept} 笔。
        </p>
        <p>
          Plaid 余额观察：删除 {c.observations_deleted} 条，保留 {c.observations_kept} 条。
        </p>
        {c.unsupported_counterparts_deleted ? (
          <p>
            旧双侧分录中 {c.unsupported_counterparts_deleted} 条对方记录没有独立银行证据，将随原分录删除。
          </p>
        ) : null}
      </div>
      {plan.connections.map((connection) => (
        <section key={connection.connectionId} className="rounded-lg border p-4">
          <h3 className="font-medium">{names[connection.connectionId] ?? "所选银行连接"}</h3>
          <p>
            {connection.currentFrom} → {plan.from} · 排队/运行任务 {connection.jobs.length} 个将被替代
          </p>
          {!connection.mapped ? <p>尚未确认映射，请完成账户映射后同步。</p> : null}
          <p className="text-xs text-muted-foreground">
            {connection.transactionsAvailable ? (
              <>
                Plaid 可提供的历史起点 ≈ {connection.availabilityStart}
                ；重置不会扩大银行保留范围，更早流水请上传 PDF/CSV。
              </>
            ) : (
              "此连接不提供交易流水，仅同步余额/持仓"
            )}
          </p>
          {connection.accounts.map((account) => (
            <div key={account.accountId} className="mt-3 border-t pt-3">
              <p className="font-medium">{names[account.accountId] ?? "已映射账户"}</p>
              <p>
                流水 {account.counts.entries_deleted} · 明细 {account.counts.postings_deleted} · 导入行{" "}
                {account.counts.rows_deleted} · 待处理 {account.counts.pending_deleted}
              </p>
              {account.openings.map((opening) => (
                <p key={opening.id} className="text-xs text-muted-foreground">
                  {opening.date} ·{" "}
                  {opening.status === "draft" ? "草稿" : opening.status === "confirmed" ? "已确认" : "已作废"}
                  期初 · {opening.suggested ? "观察/同步建议创建" : "其他来源"} ·{" "}
                  {opening.deleting ? "删除" : "保留"}
                </p>
              ))}
            </div>
          ))}
        </section>
      ))}
      <p className="text-xs text-muted-foreground">
        同一分录涉及多个账户时各账户都会显示；顶部总计已去重。保留的期初可能与重新导入的历史重叠，请核对起始日和余额。
      </p>
    </div>
  );
}
export function ResetForm({
  connectionIds,
  names,
  label = "重置导入数据",
}: {
  connectionIds: string[] | "all";
  names: Record<string, string>;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [keepOpenings, setKeepOpenings] = useState(false);
  const [deleteObservations, setDeleteObservations] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const mutation = useLedgerMutation();
  const invalidate = () => {
    setPlan(null);
    setConfirmation("");
    setResult(null);
  };
  const input = { connections: connectionIds, from: from || undefined, keepOpenings, deleteObservations };
  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setOpen(true);
          invalidate();
        }}
      >
        {label}
      </Button>
      <FormSheet
        open={open}
        onOpenChange={(value) => !mutation.pending && setOpen(value)}
        title="重置 Plaid 导入数据"
        description="保留银行连接，重新同步所选历史范围。"
      >
        <div className="space-y-5 pt-3">
          <p className="text-sm leading-7">
            只删除 Plaid 同步来的流水；手工、PDF/CSV
            流水、余额观察、积分和银行连接都会保留。默认同时删除观察/同步建议创建的期初；下面可调整期初和
            Plaid 观察选项。
          </p>
          <p className="text-sm leading-7">
            建议先在服务器运行 <code>scripts/backup.sh</code>
            。执行前会保存恢复导出，保留期内可下载；银行历史以 Plaid 实际持有的数据为限。
          </p>
          <Field
            label="重新导入起始日（留空使用默认历史窗口）"
            type="date"
            value={from}
            disabled={mutation.pending}
            onChange={(e) => {
              setFrom(e.target.value);
              invalidate();
            }}
          />
          <label className="flex items-start gap-3 text-sm leading-6">
            <input
              type="checkbox"
              checked={keepOpenings}
              disabled={mutation.pending}
              onChange={(e) => {
                setKeepOpenings(e.target.checked);
                invalidate();
              }}
              className="mt-1"
            />
            保留观察/同步建议创建的期初余额（其他期初始终保留）
          </label>
          <label className="flex items-start gap-3 text-sm leading-6">
            <input
              type="checkbox"
              checked={deleteObservations}
              disabled={mutation.pending}
              onChange={(e) => {
                setDeleteObservations(e.target.checked);
                invalidate();
              }}
              className="mt-1"
            />
            同时删除所选账户的 Plaid 余额观察（手工余额观察始终保留）
          </label>
          <Button
            variant="secondary"
            disabled={mutation.pending}
            onClick={() =>
              void mutation.run(async () => {
                const value = await api<Plan>("/api/plaid/reset", "POST", input);
                setPlan(value);
                setFrom(value.from);
                setConfirmation("");
                setResult(null);
              }, "预览已更新，尚未删除数据")
            }
          >
            预览影响范围
          </Button>
          {plan ? <ResetPreview plan={plan} names={names} /> : null}
          {plan && !result ? (
            <>
              <Field
                label="输入“重置”确认所列范围"
                value={confirmation}
                disabled={mutation.pending}
                onChange={(e) => setConfirmation(e.target.value)}
              />
              <Button
                variant="destructive"
                disabled={mutation.pending || confirmation !== "重置"}
                onClick={() =>
                  void mutation.run(
                    async () =>
                      setResult(
                        await api<Result>("/api/plaid/reset", "POST", {
                          ...input,
                          execute: true,
                          confirmation,
                        }),
                      ),
                    "重置完成，重新同步已排队",
                  )
                }
              >
                确认重置并重新同步
              </Button>
            </>
          ) : null}
          {mutation.pending ? (
            <p role="status" className="text-sm">
              正在处理，请稍候；执行时会先保存恢复导出，再重置并排队同步。
            </p>
          ) : null}
          {result ? (
            <div role="status" className="rounded-lg border p-4 text-sm leading-7">
              <p>重置完成，{result.jobs.length} 个同步任务已排队。可关闭此窗口查看连接进度。</p>
              {result.waitingForMapping.length ? (
                <p>{result.waitingForMapping.length} 个连接：完成账户映射后开始同步。</p>
              ) : null}
              <a className="text-primary underline" href={result.recovery.downloadUrl}>
                下载恢复导出（至 {result.recovery.expiresAt.slice(0, 10)}）
              </a>
            </div>
          ) : null}
          <FormError error={mutation.error} />
        </div>
      </FormSheet>
    </>
  );
}
