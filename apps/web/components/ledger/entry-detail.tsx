"use client";
import { BenefitEditor } from "@/components/benefits/editor";
import { benefitConfig, detectBenefit, type BenefitFamily } from "@/lib/benefits/config";
import { money } from "@/lib/money";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { entryLabels } from "@/lib/ledger/constants";
import { formatAmount } from "@/lib/ledger/format";
import { Field, FormError, NotesField, SelectField, api, textField, useLedgerMutation } from "./forms";
import { EntryMatching } from "./entry-matching";
import { SplitEditor } from "./split-editor";
import type { Account, Category, EntryDetail, Group } from "./types";
const auditLabels: Record<string, string> = {
  "entry.create": "创建流水",
  "entry.confirm": "确认草稿",
  "entry.void": "作废流水",
  "entry.replace": "创建替换",
  "entry.meta": "编辑说明或分类",
  "group.link": "关联购物组",
  "group.unlink": "移除购物组",
};
export function EntryDetailView({
  entry,
  accounts,
  categories,
  groups,
  today,
  onSaved,
}: {
  entry: EntryDetail;
  accounts: Account[];
  categories: Category[];
  groups: Group[];
  today: string;
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<"view" | "meta" | "replace" | "void">("view");
  const mutation = useLedgerMutation();
  if (mode === "replace")
    return (
      <>
        <Button variant="ghost" onClick={() => setMode("view")}>
          返回详情
        </Button>
        <SplitEditor
          accounts={accounts}
          categories={categories}
          today={today}
          initial={entry}
          onSaved={onSaved}
        />
      </>
    );
  if (mode === "meta")
    return (
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void mutation.run(async () => {
            const categoryChanges = entry.postings
              .filter((line) =>
                ["expense", "income"].includes(
                  accounts.find((account) => account.id === line.accountId)?.type ?? "",
                ),
              )
              .map((line) => ({ postingId: line.id, categoryId: textField(data, `category:${line.id}`) }));
            await api(`/api/transactions/${entry.id}`, "PATCH", {
              merchant: textField(data, "merchant") || null,
              description: textField(data, "description") || null,
              notes: textField(data, "notes") || null,
              categories: categoryChanges,
            });
            onSaved();
          });
        }}
      >
        <Field name="merchant" label="商户 / 对方" defaultValue={entry.merchant ?? ""} maxLength={200} />
        <Field name="description" label="说明" defaultValue={entry.description ?? ""} maxLength={2000} />
        <NotesField name="notes" defaultValue={entry.notes ?? ""} />
        {entry.postings
          .filter((line) =>
            ["expense", "income"].includes(
              accounts.find((account) => account.id === line.accountId)?.type ?? "",
            ),
          )
          .map((line) => (
            <SelectField
              key={line.id}
              name={`category:${line.id}`}
              label={`收支分类 · ${formatAmount(line.amount, line.currency)}`}
              defaultValue={line.categoryId ?? ""}
            >
              {categories
                .filter(
                  (category) =>
                    category.kind === accounts.find((account) => account.id === line.accountId)?.type &&
                    (!category.isArchived || category.id === line.categoryId),
                )
                .map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                    {category.isArchived ? "（已归档）" : ""}
                  </option>
                ))}
            </SelectField>
          ))}
        <p className="text-xs leading-6 text-muted-foreground">
          金额、账户、币种和日期的变更请使用“替换流水”，保留原始记录。
        </p>
        <FormError error={mutation.error} />
        <div className="flex gap-3">
          <Button disabled={mutation.pending} type="submit">
            保存说明
          </Button>
          <Button type="button" variant="ghost" onClick={() => setMode("view")}>
            返回
          </Button>
        </div>
      </form>
    );
  if (mode === "void")
    return (
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void mutation.run(async () => {
            await api(`/api/transactions/${entry.id}/void`, "POST", { reason: textField(data, "reason") });
            onSaved();
          }, "流水已作废");
        }}
      >
        <p className="text-sm leading-7">作废后这笔流水不再影响余额和统计，原始分录仍会保留。</p>
        <NotesField name="reason" label="作废原因" required />
        <FormError error={mutation.error} />
        <div className="flex gap-3">
          <Button type="submit" variant="destructive" disabled={mutation.pending}>
            确认作废
          </Button>
          <Button type="button" variant="ghost" onClick={() => setMode("view")}>
            返回
          </Button>
        </div>
      </form>
    );
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <Badge>{entryLabels[entry.entryType]}</Badge>
        {entry.upstream.map((change) => (
          <Link key={change.rowId} href={`/statements/${change.statementId}`}>
            <Badge variant="outline">{change.state === "modified" ? "上游已修改" : "上游已删除"}</Badge>
          </Link>
        ))}
        {entry.benefitCredit ? (
          <Badge variant="outline">
            权益报销 · {benefitConfig[entry.benefitFamily as BenefitFamily]?.label}
          </Badge>
        ) : null}
        {entry.isSummary ? <Badge variant="outline">汇总录入</Badge> : null}
        <Badge variant="outline">
          {entry.status === "confirmed" ? "已确认" : entry.status === "draft" ? "草稿" : "已作废"}
        </Badge>
      </div>
      {entry.transfer ? (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">
            转账：{entry.transfer.from.accountName} → {entry.transfer.to.accountName}
          </h2>
          <p className="font-mono text-lg">{formatAmount(entry.transfer.amount, entry.transfer.currency)}</p>
          {[entry.transfer.from, entry.transfer.to].map((side) => (
            <div key={side.entryId} className="rounded-lg border p-3 text-sm">
              <p>
                {side.accountName} · {side.date}
              </p>
              <p className="mt-1 break-words text-muted-foreground">{side.description}</p>
            </div>
          ))}
        </section>
      ) : null}
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">流水 ID</dt>
          <dd className="mt-1 font-mono text-xs break-all select-all">{entry.id}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">发生 / 入账日期</dt>
          <dd>
            {entry.eventDate} / {entry.postedDate ?? "未指定"}
          </dd>
        </div>
        {[
          ["商户 / 对方", entry.merchant],
          ["说明", entry.description],
          ["备注", entry.notes],
          ["作废原因", entry.voidReason],
          ["替换原流水", entry.replacesEntryId],
          ["退款原流水", entry.benefitCredit ? null : entry.refundOfEntryId],
        ]
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-1 break-words">{value}</dd>
            </div>
          ))}
      </dl>
      {!entry.transfer ? (
        <section>
          <h3 className="mb-3 text-sm font-medium">分录明细</h3>
          <div className="divide-y rounded-xl border bg-card px-4">
            {entry.postings.map((line) => (
              <div key={line.id} className="py-4">
                <p className="text-sm break-words">
                  {accounts.find((account) => account.id === line.accountId)?.name ?? "账户"}
                </p>
                <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {line.categoryId
                      ? categories.find((category) => category.id === line.categoryId)?.name
                      : "无收支分类"}
                  </span>
                  <span className="font-mono">{formatAmount(line.amount, line.currency)}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {entry.status !== "voided" &&
      entry.postings.filter(
        (line) =>
          money(line.amount).gt(0) &&
          accounts.some(
            (account) => account.id === line.accountId && account.type === "liability_credit_card",
          ),
      ).length === 1 ? (
        <BenefitEditor
          key={`benefit:${entry.id}`}
          entryId={entry.id}
          enabled={entry.benefitCredit}
          isRefund={entry.entryType === "refund"}
          initialFamily={
            (entry.benefitFamily as BenefitFamily | null) ??
            detectBenefit({
              accountType: "liability_credit_card",
              amount: "1",
              description: `${entry.description ?? ""} ${entry.merchant ?? ""}`,
            }) ??
            "generic"
          }
          onSaved={onSaved}
        />
      ) : null}
      {entry.status === "confirmed" ? (
        <EntryMatching key={entry.id} entryId={entry.id} matchId={entry.transferMatchId} onSaved={onSaved} />
      ) : null}
      <section>
        <h3 className="mb-3 text-sm font-medium">购物组</h3>
        {entry.purchaseGroupId ? (
          <div className="rounded-lg bg-muted p-4 text-sm">
            <p>{groups.find((group) => group.id === entry.purchaseGroupId)?.title ?? "已关联购物组"}</p>
            {entry.status !== "voided" ? (
              <Button
                variant="link"
                className="mt-2 px-0"
                disabled={mutation.pending}
                onClick={() =>
                  mutation.run(async () => {
                    await api(`/api/purchase-groups/${entry.purchaseGroupId}/entries`, "DELETE", {
                      entryId: entry.id,
                    });
                    onSaved();
                  })
                }
              >
                移除关联
              </Button>
            ) : null}
          </div>
        ) : entry.status !== "voided" &&
          ["expense", "refund", "fee", "interest"].includes(entry.entryType) ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void mutation.run(async () => {
                await api(`/api/purchase-groups/${textField(data, "group")}/entries`, "POST", {
                  entryId: entry.id,
                });
                onSaved();
              });
            }}
          >
            <SelectField name="group" label="选择购物组" required>
              <option value="">未关联</option>
              {groups
                .filter((group) => group.currency === entry.postings[0]?.currency)
                .map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.title}
                  </option>
                ))}
            </SelectField>
            <Button type="submit" variant="outline" disabled={mutation.pending}>
              关联购物组
            </Button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">未关联</p>
        )}
      </section>
      {entry.status !== "voided" ? (
        <div className="flex flex-wrap gap-2 border-t pt-5">
          {entry.status === "draft" ? (
            <Button
              disabled={mutation.pending}
              onClick={() =>
                mutation.run(async () => {
                  await api(`/api/transactions/${entry.id}/confirm`, "POST", {});
                  onSaved();
                }, "草稿已确认")
              }
            >
              确认入账
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => setMode("meta")}>
            编辑说明 / 分类
          </Button>
          <Button variant="outline" onClick={() => setMode("replace")}>
            替换流水
          </Button>
          <Button variant="ghost" onClick={() => setMode("void")}>
            作废
          </Button>
        </div>
      ) : null}
      <FormError error={mutation.error} />
      <section className="border-t pt-5">
        <h3 className="mb-3 text-sm font-medium">审计历史</h3>
        <ol className="space-y-3">
          {entry.audit.map((row) => (
            <li key={row.id} className="flex flex-wrap justify-between gap-2 text-xs">
              <span>{auditLabels[row.action] ?? row.action}</span>
              <time className="text-muted-foreground">{new Date(row.createdAt).toLocaleString("zh-CN")}</time>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-xs text-muted-foreground">审计记录中的敏感值已脱敏。</p>
      </section>
    </div>
  );
}
