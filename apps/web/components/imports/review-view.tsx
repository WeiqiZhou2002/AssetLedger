"use client";
import { StatementRewards } from "@/components/rewards/statement";
import type { statementRewardsPreview } from "@/lib/rewards/integrations";
import type { JsonSafe } from "@/lib/serialization";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { RefreshCw, ArrowLeft, AlertTriangle, FileCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FormError, FormSheet, SelectField, api, useLedgerMutation } from "@/components/ledger/forms";
import { formatAmount } from "@/lib/ledger/format";
import { approvalProblems, approvalSelection, compatibleStatementAccount } from "@/lib/imports/readiness";
import { money } from "@/lib/money";
import { entryLabels } from "@/lib/ledger/constants";
import type { Account, Category } from "@/components/ledger/types";
import { importLabel } from "./labels";
import { CsvMappingForm } from "./csv-mapping";
import { NewAccountFields, readNewAccount } from "./new-account-fields";
import { importedAccountName, uniqueAccountName } from "@/lib/imports/account-defaults";
import { RowEditor } from "./row-editor";
import { statusLabels, type AiPreview, type ImportRow, type Review } from "./types";
export function StatementReviewView({
  data,
  accounts,
  categories,
  ai,
  rewards,
  manualAccountIds = [],
}: {
  manualAccountIds?: string[];
  data: Review;
  accounts: Account[];
  categories: Category[];
  ai: AiPreview;
  rewards: JsonSafe<Awaited<ReturnType<typeof statementRewardsPreview>>>;
}) {
  const { statement, rows, jobs } = data;
  const router = useRouter();
  const mutation = useLedgerMutation();
  const [savedAccount, setSavedAccount] = useState<{ previous: string | null; id: string } | null>(null);
  const [creatingAccount, setCreatingAccount] = useState(false);
  const selectedAccountId =
    savedAccount?.previous === statement.accountId ? savedAccount.id : statement.accountId;
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<ImportRow | null>(null);
  const [page, setPage] = useState(1);
  const [category, setCategory] = useState("");
  const [aiOpen, setAiOpen] = useState(false);
  const [remove, setRemove] = useState<"file" | "discard" | null>(null);
  const busy = ["queued", "parsing"].includes(statement.status);
  const editable = !busy && !["approved", "discarded"].includes(statement.status);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [busy, router]);
  const pendingRows = rows.filter((row) => !row.journalEntryId && !row.linkedEntryId);
  const selectedRows = pendingRows.filter((row) => selected.includes(row.id));
  const { readyRows, incompleteCount } = approvalSelection(selectedRows);
  const readyIds = readyRows.map((row) => row.id);
  const ids = selectedRows.map((row) => row.id);
  const path = `/api/statements/${statement.id}`;
  const checks = statement.summary.checks ?? [];
  const warnings = checks.filter((check) => !check.matches);
  const unrecognized = statement.diagnostics
    .filter((item) => item.kind === "unrecognized_transaction_line")
    .reduce((count, item) => count + (item.count ?? 1), 0);
  const bulk = (changes: unknown) =>
    mutation.run(async () => {
      await api(`${path}/rows`, "PATCH", { rowIds: ids, changes });
      setSelected([]);
    });
  return (
    <div className="space-y-6">
      <Link href="/statements" className="inline-flex items-center gap-2 text-sm text-primary">
        <ArrowLeft size={15} />
        账单收件箱
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-medium break-all">{statement.title ?? statement.originalFilename}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {statement.issuer ?? "待识别机构"} · {statement.periodStart ?? "日期待确认"} —{" "}
            {statement.periodEnd ?? "日期待确认"}
            {statement.accountLast4 ? ` · 尾号 ${statement.accountLast4}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge>{statusLabels[statement.status]}</Badge>
          <Button variant="outline" size="sm" onClick={() => router.refresh()}>
            <RefreshCw size={14} />
            刷新
          </Button>
        </div>
      </div>
      <FormError error={mutation.error} />
      <StatementRewards statementId={statement.id} preview={rewards} />
      {busy ? (
        <p className="rounded-xl border bg-card p-5 text-sm">
          正在本地识别，完成后自动刷新。已尝试 {jobs[0]?.attempts ?? 0} 次。
        </p>
      ) : null}
      {statement.status === "failed" ? (
        <div className="rounded-xl border border-destructive/30 p-5">
          <p className="mb-3 text-sm">
            处理失败：{importLabel(jobs[0]?.errorKind ?? "unknown")}。请检查文件、映射或服务。
          </p>
          <Button
            disabled={mutation.pending || !statement.fileAvailable}
            onClick={() =>
              void mutation.run(async () => {
                await api(`${path}/retry`, "POST");
              })
            }
          >
            重新本地解析
          </Button>
        </div>
      ) : null}
      {statement.source === "upload" ? (
        <div className="grid gap-4 rounded-xl border bg-card p-5 sm:grid-cols-[1fr_auto]">
          <SelectField
            label="账单所属账户"
            value={creatingAccount ? "new" : (selectedAccountId ?? "")}
            disabled={
              mutation.pending || !editable || rows.some((row) => row.journalEntryId || row.linkedEntryId)
            }
            onChange={(event) => {
              const accountId = event.target.value;
              setCreatingAccount(accountId === "new");
              if (accountId === "new") return;
              if (accountId)
                void mutation.run(async () => {
                  const saved = await api<{ accountId: string }>(path, "PATCH", { accountId });
                  setSavedAccount({ previous: statement.accountId, id: saved.accountId });
                  // mutation.run refreshes server data after this save, including status and rows.
                });
            }}
          >
            <option value="">请选择账户</option>
            <option value="new">新建账户</option>
            {accounts
              .filter((account) =>
                compatibleStatementAccount(
                  statement.statementType,
                  account,
                  account.id === selectedAccountId,
                  statement.currency,
                ),
              )
              .map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} · {account.currency}
                </option>
              ))}
          </SelectField>
          <div className="flex flex-wrap items-end gap-2">
            {statement.summary.ending_balance !== undefined &&
            manualAccountIds.includes(selectedAccountId ?? "") ? (
              <Button
                variant="outline"
                disabled={mutation.pending || !statement.accountId || busy}
                onClick={() =>
                  void mutation.run(async () => {
                    await api(`${path}/observation`, "POST");
                  }, "已更新账单期末余额")
                }
              >
                <FileCheck size={15} />
                记录账单期末余额
              </Button>
            ) : null}
            {ai.available ? (
              <Button variant="outline" onClick={() => setAiOpen(true)}>
                AI 辅助解析
              </Button>
            ) : null}
          </div>
          {creatingAccount ? (
            <form
              className="space-y-4 sm:col-span-2"
              onSubmit={(event) => {
                event.preventDefault();
                const create = readNewAccount(new FormData(event.currentTarget), "statement-account");
                void mutation.run(async () => {
                  const saved = await api<{ accountId: string }>(path, "PATCH", { create });
                  setSavedAccount({ previous: statement.accountId, id: saved.accountId });
                  setCreatingAccount(false);
                }, "新账户已创建并关联账单");
              }}
            >
              <NewAccountFields
                prefix="statement-account"
                name={uniqueAccountName(
                  importedAccountName(
                    statement.issuer ?? "",
                    statement.statementType === "credit_card" ? "信用卡" : "银行账户",
                    statement.accountLast4,
                  ),
                  accounts.map((row) => row.name),
                )}
                type={statement.statementType === "credit_card" ? "liability_credit_card" : "asset_cash"}
                types={
                  statement.statementType === "credit_card"
                    ? ["liability_credit_card"]
                    : statement.statementType === "bank"
                      ? ["asset_cash", "asset_brokerage_cash"]
                      : ["asset_cash", "asset_brokerage_cash", "liability_credit_card"]
                }
                currency={statement.currency ?? "USD"}
                last4={statement.accountLast4}
              />
              <p className="text-xs text-muted-foreground">
                机构：{statement.issuer ?? "未命名机构"}；保存时复用或新建。
              </p>
              <Button type="submit" disabled={mutation.pending || !editable}>
                创建并设为账单账户
              </Button>
            </form>
          ) : null}
        </div>
      ) : (
        <p className="rounded-xl border bg-card p-5 text-sm leading-7">
          来源：Plaid 同步。各行显示映射后的账本账户；没有 PDF
          原件。余额已单独保存为机构观察，未批准的行不影响账本。
        </p>
      )}
      {statement.mime === "text/csv" && statement.accountId && editable && statement.fileAvailable ? (
        <CsvMappingForm
          statementId={statement.id}
          headers={statement.summary.csv_headers ?? []}
          skipRows={statement.summary.csv_skip_rows ?? 0}
        />
      ) : null}
      {warnings.length ? (
        <p
          role="alert"
          className="flex gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
        >
          <AlertTriangle className="shrink-0" size={18} />
          识别金额与账单汇总存在 {warnings.length} 处差异，请对照原件核对后再决定是否入账。
        </p>
      ) : null}
      <details className="rounded-xl border bg-card p-5" open={Boolean(warnings.length)}>
        <summary className="cursor-pointer text-sm font-medium">
          账单总额校验 · 未识别交易行 {unrecognized} · {rows.length} 条候选
        </summary>
        <p className="mt-3 text-xs leading-6 text-muted-foreground">
          以下比较原始解析结果与账单印刷总额；手工更正仍须对照原件。汇总金额不会生成交易。
        </p>
        {checks.length ? (
          <ul className="mt-3 space-y-2 text-xs">
            {checks.map((check, index) => (
              <li key={index} className="flex flex-wrap justify-between gap-2">
                <span>{importLabel(check.kind)}</span>
                <span>
                  {formatAmount(check.actual, statement.currency ?? "USD")} / 印刷{" "}
                  {formatAmount(check.expected, statement.currency ?? "USD")} ·{" "}
                  {check.matches ? "相符" : "不符"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">没有可核对的印刷总额，请逐行审核。</p>
        )}
        {statement.summary.ending_balance !== undefined ? (
          <p className="mt-3 text-sm">
            期末账户余额 {formatAmount(statement.summary.ending_balance, statement.currency ?? "USD")}
          </p>
        ) : null}
        {statement.diagnostics.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {statement.diagnostics.map((item, index) => (
              <Badge key={index} variant="outline">
                {importLabel(item.kind)}
                {item.page ? ` · 页 ${item.page}` : ""}
                {item.count !== undefined ? ` · ${item.count} 行` : ""}
              </Badge>
            ))}
          </div>
        ) : null}
      </details>
      <div
        className={`grid min-w-0 items-start gap-5 ${statement.mime === "application/pdf" ? "xl:grid-cols-[minmax(300px,0.85fr)_minmax(0,1.6fr)]" : ""}`}
      >
        {statement.mime === "application/pdf" ? (
          <aside className="min-w-0 rounded-xl border bg-card p-3 xl:sticky xl:top-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((value) => value - 1)}
              >
                上一页
              </Button>
              <span className="text-xs">
                {page} / {statement.pageCount ?? "?"}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={page >= (statement.pageCount ?? 1)}
                onClick={() => setPage((value) => value + 1)}
              >
                下一页
              </Button>
            </div>
            {statement.fileAvailable ? (
              <Image
                unoptimized
                src={`${path}/render?page=${page}`}
                alt={`原始账单第 ${page} 页`}
                width={612}
                height={792}
                className="h-auto w-full rounded border"
              />
            ) : (
              <p className="p-6 text-sm text-muted-foreground">原件已删除，识别行和入账证据仍保留。</p>
            )}
          </aside>
        ) : null}
        <section className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled={!editable}
                checked={pendingRows.length > 0 && ids.length === pendingRows.length}
                onChange={(event) =>
                  setSelected(event.target.checked ? pendingRows.map((row) => row.id) : [])
                }
              />
              全选待处理行
            </label>
            <span className="text-xs text-muted-foreground">
              已选 {ids.length} · {incompleteCount} 行待补全
            </span>
            <select
              aria-label="批量分类"
              className="h-9 max-w-40 rounded border bg-background px-2 text-sm"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="">批量分类</option>
              {categories
                .filter((row) => !row.isArchived)
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              disabled={!ids.length || !category || mutation.pending}
              onClick={() => void bulk({ suggestedCategoryId: category })}
            >
              应用分类
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!ids.length || mutation.pending}
              onClick={() => void bulk({ decision: "exclude" })}
            >
              排除
            </Button>
            <Button
              size="sm"
              className="h-auto min-h-8 max-w-full py-2 whitespace-normal"
              disabled={
                !readyIds.length ||
                (!selectedAccountId && statement.source !== "plaid") ||
                mutation.pending ||
                !editable
              }
              onClick={() =>
                void mutation.run(async () => {
                  const pending = readyRows.filter((row) => row.decision === "pending").map((row) => row.id);
                  if (pending.length)
                    await api(`${path}/rows`, "PATCH", { rowIds: pending, changes: { decision: "approve" } });
                  await api(`${path}/approve`, "POST", {
                    rowIds: readyIds,
                    idempotencyKey: crypto.randomUUID(),
                  });
                  setSelected((value) => value.filter((id) => !readyIds.includes(id)));
                }, "审核结果已原子入账")
              }
            >
              批准可入账的 {readyIds.length} 行（跳过 {incompleteCount} 行待补全）
            </Button>
          </div>
          {rows.length ? (
            <div className="overflow-x-auto rounded-xl border bg-card">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    {["选择", "日期 / 商户", "金额", "建议 / 审核", "操作"].map((title) => (
                      <th key={title} className="p-3 font-normal">
                        {title}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((row) => {
                    const entryId = row.journalEntryId ?? row.linkedEntryId;
                    const duplicate =
                      row.duplicateCandidateEntryIds.length + row.duplicateCandidateRowIds.length;
                    return (
                      <tr
                        key={row.id}
                        className={duplicate && row.duplicateResolution === "none" ? "bg-amber-50/70" : ""}
                      >
                        <td className="p-3">
                          <input
                            aria-label={`选择第 ${row.rowIndex + 1} 行`}
                            type="checkbox"
                            disabled={Boolean(entryId) || !editable}
                            checked={selected.includes(row.id)}
                            onChange={(event) =>
                              setSelected((value) =>
                                event.target.checked
                                  ? [...value, row.id]
                                  : value.filter((id) => id !== row.id),
                              )
                            }
                          />
                        </td>
                        <td className="max-w-56 p-3">
                          <p className="text-xs text-muted-foreground">
                            {row.postedDate ?? row.transactionDate ?? "日期待补充"}
                          </p>
                          <p className="mt-1 font-medium break-words">
                            {row.merchantNormalized || row.descriptionRaw}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">{row.descriptionRaw}</p>
                          {row.accountId ? (
                            <p className="mt-1 text-xs text-primary">
                              {accounts.find((account) => account.id === row.accountId)?.name ??
                                "账户映射缺失"}
                            </p>
                          ) : null}
                          {row.sourcePage ? (
                            <button
                              className="mt-1 text-xs text-primary"
                              onClick={() => setPage(row.sourcePage!)}
                            >
                              查看原页 {row.sourcePage}
                            </button>
                          ) : null}
                        </td>
                        <td className="p-3 font-mono text-xs whitespace-nowrap">
                          {formatAmount(row.amount, row.currency)}
                        </td>
                        <td className="max-w-64 space-y-2 p-3">
                          {row.upstreamState !== "none" ? (
                            <Badge variant="outline">
                              {row.upstreamState === "modified" ? "上游已修改" : "上游已删除"}
                            </Badge>
                          ) : null}
                          {row.upstreamState === "modified" && row.upstreamPayload ? (
                            <details className="text-xs">
                              <summary>查看上游变更</summary>
                              <pre className="mt-2 max-w-60 break-all whitespace-pre-wrap">
                                {JSON.stringify(row.upstreamPayload, null, 2)}
                              </pre>
                            </details>
                          ) : null}
                          <p>
                            {row.suggestedEntryType ? entryLabels[row.suggestedEntryType] : "类型待定"} ·{" "}
                            {categories.find((category) => category.id === row.suggestedCategoryId)?.name ??
                              "未分类"}
                          </p>
                          <Badge variant={money(row.confidence).lt("0.7") ? "outline" : "secondary"}>
                            {row.source === "ai" ? "AI · " : ""}信心{" "}
                            {money(row.confidence).mul("100").toFixed(0)}%
                          </Badge>
                          <p className="text-xs">
                            {entryId
                              ? "已入账 / 已关联"
                              : row.decision === "exclude"
                                ? "已排除"
                                : row.decision === "approve"
                                  ? "待提交入账"
                                  : "待审核"}
                          </p>
                          {approvalProblems(row).map((problem) => (
                            <p key={problem} className="text-xs font-medium text-destructive">
                              {problem}
                            </p>
                          ))}
                          {row.softNotes.map((note) => (
                            <p className="text-xs text-muted-foreground" key={note}>
                              {note}
                            </p>
                          ))}
                          {duplicate ? (
                            <p className="text-xs text-amber-900">
                              {duplicate} 个重复候选 ·{" "}
                              {row.duplicateResolution === "distinct"
                                ? "已确认不同"
                                : row.duplicateResolution === "duplicate"
                                  ? "已确认重复"
                                  : "尚未判断"}
                            </p>
                          ) : null}
                          {row.duplicateCandidateEntryIds.map((id) => (
                            <Link
                              className="block text-xs text-primary underline"
                              key={id}
                              href={`/activity?entryId=${id}`}
                            >
                              查看已有流水 {id.slice(0, 8)}
                            </Link>
                          ))}
                          {row.pairing.length ? (
                            <p className="text-xs text-primary">{row.pairing.length} 个还卡配对建议</p>
                          ) : null}
                        </td>
                        <td className="p-3">
                          {entryId ? (
                            <Link className="text-xs text-primary" href={`/activity?entryId=${entryId}`}>
                              查看流水
                            </Link>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!editable || mutation.pending}
                              onClick={() => setEditing(row)}
                            >
                              编辑审核
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
              暂无候选行。请先完成账户匹配或列映射；若原件没有交易，也不会根据汇总额造出流水。
            </p>
          )}
        </section>
      </div>
      {statement.source === "upload" ? (
        <div className="flex flex-wrap gap-3">
          <Button
            variant="ghost"
            disabled={!statement.fileAvailable || mutation.pending}
            onClick={() => setRemove("file")}
          >
            立即删除原件
          </Button>
          {statement.status !== "approved" && statement.status !== "discarded" ? (
            <Button variant="ghost" disabled={mutation.pending} onClick={() => setRemove("discard")}>
              丢弃此账单
            </Button>
          ) : null}
        </div>
      ) : null}
      <FormSheet
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title="审核交易行"
        description="确认日期、金额、类别和借贷方向；所有入账仍经过同一账本校验。"
      >
        {editing ? (
          <RowEditor
            key={editing.id}
            row={editing}
            accounts={accounts}
            categories={categories}
            onSaved={() => setEditing(null)}
          />
        ) : null}
      </FormSheet>
      <FormSheet
        open={aiOpen}
        onOpenChange={setAiOpen}
        title="确认发送给 AI"
        description="仅发送下面列出的交易区域文本，不包含完整 PDF、页眉或地址。"
      >
        <p className="mb-4 text-sm">
          提供方：{ai.provider} · 请求模型：{ai.model}（允许提供方使用服务端备用模型）
        </p>
        <pre className="max-h-96 overflow-auto rounded border bg-muted/30 p-3 text-xs break-all whitespace-pre-wrap">
          {JSON.stringify(ai.lines, null, 2)}
        </pre>
        <p className="my-4 text-sm leading-7">
          这些文本将离开本机，发送给上述服务。长数字已遮盖；请检查其中的商户及个人信息。AI
          结果仍需你逐行审核。
        </p>
        <FormError error={mutation.error} />
        <Button
          disabled={mutation.pending}
          onClick={() =>
            void mutation.run(async () => {
              await api(`${path}/ai`, "POST", { confirmed: true, inputHash: ai.inputHash });
              setAiOpen(false);
            }, "已记录本次授权并排队")
          }
        >
          确认发送以上内容
        </Button>
      </FormSheet>
      <FormSheet
        open={Boolean(remove)}
        onOpenChange={(open) => {
          if (!open) setRemove(null);
        }}
        title={remove === "discard" ? "丢弃账单" : "删除原件"}
        description="原始 PDF/CSV 和页面缓存将删除，识别行与入账证据保留；已有流水不会被作废。"
      >
        <FormError error={mutation.error} />
        <Button
          variant="destructive"
          disabled={mutation.pending}
          onClick={() =>
            void mutation.run(async () => {
              await api(`${path}/file${remove === "discard" ? "?discard=true" : ""}`, "DELETE");
              setRemove(null);
            }, "原件已删除")
          }
        >
          确认删除
        </Button>
      </FormSheet>
    </div>
  );
}
