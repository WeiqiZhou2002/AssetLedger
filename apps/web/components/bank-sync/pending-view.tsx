"use client";
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FormError, SelectField, api, useLedgerMutation } from "@/components/ledger/forms";
import type { Account, Category } from "@/components/ledger/types";
import type { JsonSafe } from "@/lib/serialization";
import type { pendingWorkbench } from "@/lib/bank-sync/pending";
import { formatAmount } from "@/lib/ledger/format";
import { entryLabels } from "@/lib/ledger/constants";
import { money } from "@/lib/money";
import { MoneyAmount } from "@/components/money-amount";
type Workbench = JsonSafe<Awaited<ReturnType<typeof pendingWorkbench>>>;
type Transfer = Workbench["transfers"][number];
export function PendingView({
  data,
  accounts,
  categories,
}: {
  data: Workbench;
  accounts: Account[];
  categories: Category[];
}) {
  return (
    <div className="space-y-6">
      <section id="pending" className="scroll-mt-6 space-y-4 rounded-xl border bg-card p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-medium">待处理</h2>
          <Badge variant={data.count ? "default" : "outline"}>{data.count}</Badge>
        </div>
        <p className="text-xs leading-6 text-muted-foreground">
          未自动配对的流水已按收支入账；“可能的转账”确认后两侧改为转账，你的确认会被记住。这里只列需要你处理的事项。
        </p>
        {!data.count ? <p className="py-4 text-sm text-muted-foreground">没有待处理事项。</p> : null}
        <TransferSuggestions items={data.suggestions} />
        {data.transfers.map((leg) => (
          <TransferItem key={leg.id} leg={leg} accounts={accounts} categories={categories} />
        ))}
        {data.rows.map((item) => (
          <EvidenceItem key={item.row.id} item={item} />
        ))}
      </section>
      <section className="rounded-xl border bg-card p-5">
        <h2 className="mb-4 font-medium">最近自动入账</h2>
        {data.recent.length ? (
          <ul className="divide-y">
            {data.recent.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-start justify-between gap-2 py-3 text-sm">
                <div className="min-w-0">
                  <Link
                    className="break-words text-primary underline-offset-4 hover:underline"
                    href={`/activity?entryId=${entry.id}`}
                  >
                    {entry.transfer
                      ? `${entry.transfer.from.accountName} → ${entry.transfer.to.accountName}`
                      : entry.merchant || entryLabels[entry.type]}
                  </Link>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {entry.date ?? entry.eventDate} · {entry.accountName} · {entryLabels[entry.type]}
                    {entry.transferMatchId ? " · 已匹配" : ""}
                  </p>
                </div>
                <span className="tabular-nums">
                  {formatAmount(entry.transfer?.amount ?? entry.amount, entry.currency)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">同步完成后，已入账交易会显示在这里。</p>
        )}
      </section>
    </div>
  );
}
export function TransferSuggestions({ items }: { items: Workbench["suggestions"] }) {
  const mutation = useLedgerMutation();
  if (!items.length) return null;
  const resolve = (item: Workbench["suggestions"][number], action: "confirm" | "reject") =>
    void mutation.run(
      async () => {
        await api("/api/transfer-suggestions", "POST", {
          action,
          entryId: item.left.id,
          counterpartEntryId: item.right.id,
        });
      },
      action === "confirm" ? "已确认为转账" : "已排除此配对",
    );
  return (
    <section aria-label="可能的转账" className="min-w-0 space-y-3">
      <h3 className="text-sm font-medium">可能的转账（{items.length}）</h3>
      <p className="text-xs leading-6 text-muted-foreground">
        金额相反、相隔 5
        天内、但缺少足够转账信号的流水；确认后两笔都改为转账，不再计入收支；选「不是」后不再提示。
      </p>
      <FormError error={mutation.error} />
      {items.map((item) => (
        <article key={item.key} className="min-w-0 space-y-4 rounded-lg border p-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{item.type === "credit_card_payment" ? "信用卡还款" : "转账"}</Badge>
            <span>相差 {item.days} 天</span>
            {item.alternatives > 0 ? <span>另有 {item.alternatives} 个候选</span> : null}
          </div>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            {[item.left, item.right].map((leg) => (
              <div key={leg.id} className="min-w-0 space-y-2 text-sm">
                <p className="text-xs leading-6 break-words text-muted-foreground">
                  {leg.date} · {leg.accountName}
                </p>
                <Link
                  href={`/activity?entryId=${leg.id}`}
                  className="block break-words text-primary underline-offset-4 hover:underline"
                >
                  {leg.description || "查看流水"}
                </Link>
                <MoneyAmount value={leg.amount} currency={leg.currency} />
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={mutation.pending} onClick={() => resolve(item, "confirm")}>
              是转账
            </Button>
            <Button variant="outline" disabled={mutation.pending} onClick={() => resolve(item, "reject")}>
              不是
            </Button>
          </div>
        </article>
      ))}
    </section>
  );
}
function TransferItem({
  leg,
  accounts,
  categories,
}: {
  leg: Transfer;
  accounts: Account[];
  categories: Category[];
}) {
  const mutation = useLedgerMutation();
  const [action, setAction] = useState("match");
  const [type, setType] = useState("expense");
  const positive = money(leg.amount).gt(0);
  const loans = type === "loan_out" || type === "loan_repayment";
  const compatible = accounts.filter(
    (account) =>
      account.isActive &&
      !account.isSystem &&
      account.id !== leg.accountId &&
      account.currency === leg.currency,
  );
  return (
    <details className="rounded-lg border p-4">
      <summary className="cursor-pointer text-sm leading-6">
        <Badge variant="outline" className="mr-2">
          {leg.clearing ? "待匹配转账" : "可能为转账"}
        </Badge>
        {leg.accountName} · {formatAmount(leg.amount, leg.currency)}
        <span className="mt-1 block text-xs text-muted-foreground">
          {leg.date} · {leg.description} · {leg.candidates.length} 个候选
        </span>
      </summary>
      <ul className="mt-3 space-y-2 text-xs leading-6 text-muted-foreground">
        {leg.diagnostics.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
      <Link className="text-xs text-primary underline" href={`/activity?entryId=${leg.id}`}>
        查看流水 / 编辑说明与分类
      </Link>
      <form
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const body = {
            action,
            entryId: leg.id,
            ...(action === "match" ? { counterpartEntryId: data.get("counterpart") } : {}),
            ...(action === "assign" || (action === "categorize" && loans)
              ? { accountId: data.get("account") }
              : {}),
            ...(action === "categorize"
              ? { type, ...(!loans ? { categoryId: data.get("category") } : {}) }
              : {}),
          };
          void mutation.run(async () => {
            await api("/api/plaid/pending", "POST", body);
          }, "待处理事项已更新");
        }}
      >
        <SelectField label="处理方式" value={action} onChange={(event) => setAction(event.target.value)}>
          <option value="match">匹配为转账</option>
          {leg.clearing ? (
            <>
              <option value="assign">指定对方账户</option>
              <option value="categorize">归为收支</option>
            </>
          ) : null}
        </SelectField>
        {action === "match" ? (
          <SelectField
            label="反向等额候选（相隔至多七天，含手工 / PDF）"
            name="counterpart"
            defaultValue=""
            required
          >
            <option value="">
              {leg.candidates.length ? "选择对应银行流水" : "暂无候选，可等待下次同步"}
            </option>
            {leg.candidates.map((row) => (
              <option key={row.id} value={row.id}>
                {row.date} · {row.accountName} · {formatAmount(row.amount, row.currency)}
              </option>
            ))}
          </SelectField>
        ) : null}
        {action === "categorize" ? (
          <SelectField label="交易类型" value={type} onChange={(event) => setType(event.target.value)}>
            <option value="expense">消费</option>
            <option value="income">收入</option>
            <option value="refund">退款</option>
            <option value="loan_out">借出</option>
            <option value="loan_repayment">收回借款</option>
          </SelectField>
        ) : null}
        {action === "assign" || (action === "categorize" && loans) ? (
          <SelectField
            label={loans && action === "categorize" ? "应收款账户" : "对方账户"}
            name="account"
            defaultValue=""
            required
          >
            <option value="">请选择账户</option>
            {compatible
              .filter((row) =>
                action === "categorize"
                  ? row.type === "asset_receivable"
                  : leg.accountType === "liability_credit_card"
                    ? ["asset_cash", "asset_brokerage_cash"].includes(row.type)
                    : ["asset_cash", "asset_brokerage_cash", "liability_loan"].includes(row.type) ||
                      (!positive &&
                        leg.accountType !== "liability_loan" &&
                        row.type === "liability_credit_card"),
              )
              .map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
          </SelectField>
        ) : null}
        {action === "categorize" && !loans ? (
          <SelectField label="分类" name="category" defaultValue="" required>
            <option value="">请选择分类</option>
            {categories
              .filter((row) => !row.isArchived && row.kind === (type === "income" ? "income" : "expense"))
              .map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
          </SelectField>
        ) : null}
        {action === "assign" ? (
          <p className="text-xs leading-6 text-muted-foreground">
            将在指定账户同日补记反向分录并关联；请先核实该账户尚未记过这笔款项。
          </p>
        ) : null}
        <FormError error={mutation.error} />
        <Button type="submit" disabled={mutation.pending || (action === "match" && !leg.candidates.length)}>
          确认处理
        </Button>
      </form>
    </details>
  );
}
function EvidenceItem({ item }: { item: Workbench["rows"][number] }) {
  const { row } = item;
  const mutation = useLedgerMutation();
  const [entryId, setEntryId] = useState(row.linkedEntryId ?? row.duplicateCandidateEntryIds[0] ?? "");
  const duplicate = row.autoPostState === "duplicate";
  const action = (value: string) =>
    void mutation.run(async () => {
      await api("/api/plaid/pending", "POST", {
        action: value,
        rowId: row.id,
        ...(value === "keep_existing" ? { entryId } : {}),
      });
    }, "待处理事项已更新");
  return (
    <article className="space-y-3 rounded-lg border p-4 text-sm">
      <Badge variant="outline">
        {duplicate ? "疑似重复" : row.upstreamState === "removed" ? "上游已删除" : "上游已修改"}
      </Badge>
      <p className="break-words">
        {item.accountName} · {row.merchantNormalized} · {formatAmount(row.amount, row.currency)}
      </p>
      <p className="text-xs leading-6 text-muted-foreground">
        {row.postedDate ?? row.transactionDate} ·{" "}
        {duplicate ? "已保留来源证据，尚未重复入账。" : "流水经过人工编辑；请核对上游证据后处理。"}
      </p>
      {row.upstreamState === "modified" && row.upstreamPayload ? (
        <p className="text-xs leading-6">
          上游：{String(row.upstreamPayload.postedDate ?? "")} ·{" "}
          {String(row.upstreamPayload.description ?? "")} ·{" "}
          {typeof row.upstreamPayload.amount === "string"
            ? formatAmount(row.upstreamPayload.amount, String(row.upstreamPayload.currency ?? row.currency))
            : ""}
        </p>
      ) : null}
      {duplicate ? (
        <>
          <SelectField label="已有流水" value={entryId} onChange={(event) => setEntryId(event.target.value)}>
            {item.duplicateEntries.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.date ?? entry.eventDate} · {entry.merchant || entry.description || "已有流水"}
                {entry.status !== "confirmed" ? "（非已确认）" : ""}
              </option>
            ))}
          </SelectField>
          <Link className="block text-xs text-primary" href={`/activity?entryId=${entryId}`}>
            查看已有流水 →
          </Link>
        </>
      ) : null}
      <Link className="block text-xs text-primary" href={`/statements/${row.statementId}`}>
        查看同步来源证据 →
      </Link>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={mutation.pending}
          onClick={() => action(duplicate ? "keep_existing" : "keep_local")}
        >
          {duplicate ? "保留已有" : "保留本地"}
        </Button>
        <Button
          disabled={mutation.pending || (duplicate && row.upstreamState === "removed")}
          onClick={() => action(duplicate ? "post_distinct" : "apply_upstream")}
        >
          {duplicate ? "仍然入账" : "按上游作废 / 替换"}
        </Button>
      </div>
      <FormError error={mutation.error} />
    </article>
  );
}
