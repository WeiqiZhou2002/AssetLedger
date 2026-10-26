"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  ChartNoAxesCombined,
  CreditCard,
  Plus,
  ReceiptText,
  SlidersHorizontal,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  entryLabels,
  entryTypes,
  systemTypes,
  type EntryType,
  type SystemType,
} from "@/lib/ledger/constants";
import { formatAmount } from "@/lib/ledger/format";
import { money } from "@/lib/money";
import { Field, FormError, FormSheet, SelectField, api } from "./forms";
import { QuickEntry } from "./quick-entry";
import { SplitEditor } from "./split-editor";
import { EntryDetailView } from "./entry-detail";
import { PurchaseGroupsView } from "./purchase-groups-view";
import type { Account, Category, EntryDetail, EntryList, Group } from "./types";
function EntryIcon({ type }: { type: EntryType }) {
  const Icon =
    type === "expense" || type === "fee"
      ? ReceiptText
      : type === "income" || type === "refund"
        ? ArrowDownLeft
        : type === "transfer"
          ? ArrowLeftRight
          : type === "credit_card_payment"
            ? CreditCard
            : type.startsWith("investment")
              ? ChartNoAxesCombined
              : type.startsWith("loan")
                ? ArrowUpRight
                : Wallet;
  return <Icon size={18} strokeWidth={1.6} aria-hidden />;
}
export function ActivityView({
  initialEntry,
  data,
  accounts,
  categories,
  groups,
  today,
  settings,
  filters,
}: {
  initialEntry?: EntryDetail | null;
  data: EntryList;
  accounts: Account[];
  categories: Category[];
  groups: Group[];
  today: string;
  settings: { prepaymentMode: "asset" | "expense"; spendingDateBasis: "posted" | "event" };
  filters: Record<string, string>;
}) {
  const router = useRouter();
  const [createMode, setCreateMode] = useState<"quick" | "advanced" | null>(null);
  const [detail, setDetail] = useState<EntryDetail | null>(initialEntry ?? null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const days = [...new Set(data.entries.map((entry) => entry.effectiveDate))];
  async function openDetail(id: string) {
    setLoading(id);
    setError("");
    try {
      setDetail(await api<EntryDetail>(`/api/transactions/${id}`));
    } catch (error) {
      setError(error instanceof Error ? error.message : "无法加载流水");
    } finally {
      setLoading(null);
    }
  }
  function navigate(values: Record<string, string>) {
    const params = new URLSearchParams({ ...filters, ...values });
    for (const [key, value] of [...params]) if (!value) params.delete(key);
    router.push(`/activity?${params.toString()}`);
  }
  return (
    <>
      <Tabs defaultValue="activity">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="activity">每日流水</TabsTrigger>
            <TabsTrigger value="groups">购物组</TabsTrigger>
          </TabsList>
          <Button onClick={() => setCreateMode("quick")}>
            <Plus size={16} />
            记一笔
          </Button>
        </div>
        <TabsContent value="activity">
          <div className="mb-5 flex flex-wrap gap-2">
            {[
              ["spending", "仅真实消费"],
              ["income", "仅收入"],
              ["cashflow", "全部现金流"],
              ["all", "所有交易"],
            ].map(([view, label]) => (
              <Button
                key={view}
                size="sm"
                variant={(filters.view ?? "all") === view ? "default" : "outline"}
                onClick={() => navigate({ view, offset: "0" })}
              >
                {label}
              </Button>
            ))}
            <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              <SlidersHorizontal size={15} />
              筛选
            </Button>
          </div>
          {expanded ? (
            <form
              key={JSON.stringify(filters)}
              className="mb-6 grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2 xl:grid-cols-3"
              onSubmit={(event) => {
                event.preventDefault();
                const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<
                  string,
                  string
                >;
                navigate({ ...values, offset: "0" });
              }}
            >
              <Field name="from" label="开始日期" type="date" defaultValue={filters.from} />
              <Field name="to" label="结束日期" type="date" defaultValue={filters.to} />
              <SelectField
                name="basis"
                label="日期口径"
                defaultValue={filters.basis ?? settings.spendingDateBasis}
              >
                <option value="posted">入账日（无则用发生日）</option>
                <option value="event">发生日</option>
              </SelectField>
              <SelectField name="accountId" label="账户" defaultValue={filters.accountId}>
                <option value="">全部账户</option>
                {accounts
                  .filter((account) => !account.isSystem)
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
              </SelectField>
              <SelectField name="categoryId" label="分类" defaultValue={filters.categoryId}>
                <option value="">全部分类</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </SelectField>
              <SelectField name="type" label="交易类型" defaultValue={filters.type}>
                <option value="">全部类型</option>
                {entryTypes.map((type) => (
                  <option key={type} value={type}>
                    {entryLabels[type]}
                  </option>
                ))}
              </SelectField>
              <SelectField name="status" label="状态" defaultValue={filters.status}>
                <option value="">未作废</option>
                <option value="confirmed">已确认</option>
                <option value="draft">草稿</option>
                <option value="voided">已作废</option>
              </SelectField>
              <Field name="merchant" label="商户关键词" defaultValue={filters.merchant} />
              <Field name="minAmount" label="最小金额" inputMode="decimal" defaultValue={filters.minAmount} />
              <Field name="maxAmount" label="最大金额" inputMode="decimal" defaultValue={filters.maxAmount} />
              <SelectField name="currency" label="金额币种" defaultValue={filters.currency}>
                <option value="">任一币种（不合并）</option>
                {[...new Set(accounts.map((account) => account.currency))].map((currency) => (
                  <option key={currency}>{currency}</option>
                ))}
              </SelectField>
              <div className="flex items-end gap-2">
                <Button type="submit">应用筛选</Button>
                <Button type="button" variant="ghost" onClick={() => router.push("/activity")}>
                  清除
                </Button>
              </div>
            </form>
          ) : null}
          <p className="mb-5 text-xs leading-6 text-muted-foreground">
            {data.total} 笔记录 ·{" "}
            {filters.basis === "event" || (!filters.basis && settings.spendingDateBasis === "event")
              ? "按发生日期"
              : "按入账日期"}{" "}
            · 金额为每个币种借方合计，退款以负数展示。草稿和作废不计入余额或消费统计。
          </p>
          <FormError error={error} />
          {days.length ? (
            <div className="space-y-7">
              {days.map((day) => (
                <section key={day}>
                  <h2 className="mb-3 text-xs font-medium tracking-wide text-muted-foreground">{day}</h2>
                  <div className="divide-y overflow-hidden rounded-xl border bg-card">
                    {data.entries
                      .filter((entry) => entry.effectiveDate === day)
                      .map((entry) => (
                        <button
                          key={entry.id}
                          disabled={loading === entry.id}
                          onClick={() => openDetail(entry.id)}
                          className="flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-muted/50 disabled:opacity-60 sm:p-5"
                        >
                          <span className="mt-0.5 rounded-lg bg-primary/5 p-2 text-primary">
                            <EntryIcon type={entry.entryType} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {entry.transfer
                                ? entry.transfer.type === "credit_card_payment"
                                  ? "信用卡还款"
                                  : "转账"
                                : entry.merchant || entry.description || entryLabels[entry.entryType]}
                            </span>
                            <span className="mt-1 block truncate text-xs text-muted-foreground">
                              {entry.transfer ? (
                                `${entry.transfer.from.accountName} → ${entry.transfer.to.accountName}`
                              ) : (
                                <>
                                  {entryLabels[entry.entryType]} ·{" "}
                                  {entry.postings
                                    .filter((line) => !systemTypes.includes(line.accountType as SystemType))
                                    .map((line) => line.accountName)
                                    .join(" → ")}
                                </>
                              )}
                            </span>
                            {entry.isSummary ? (
                              <Badge variant="outline" className="mt-2 text-[10px]">
                                汇总录入
                              </Badge>
                            ) : null}
                            {entry.status !== "confirmed" ? (
                              <Badge variant="outline" className="mt-2 text-[10px]">
                                {entry.status === "draft" ? "草稿" : "已作废"}
                              </Badge>
                            ) : null}
                          </span>
                          <span className="max-w-[45%] shrink-0 text-right font-mono text-xs leading-6 sm:text-sm">
                            {Object.entries(
                              entry.transfer
                                ? { [entry.transfer.currency]: entry.transfer.amount }
                                : entry.amounts,
                            ).map(([currency, value]) => (
                              <span key={currency} className="block break-all">
                                {formatAmount(
                                  entry.entryType === "refund" ? money(value).negated().toFixed(4) : value,
                                  currency,
                                )}
                              </span>
                            ))}
                          </span>
                        </button>
                      ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border bg-card p-8">
              <h2 className="font-medium">这里还没有匹配的流水</h2>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">
                记下第一笔真实交易，或调整筛选范围。只有已确认分录会影响账本余额。
              </p>
              <Button variant="outline" className="mt-5" onClick={() => setCreateMode("quick")}>
                记一笔
              </Button>
            </div>
          )}
          {data.total > data.limit ? (
            <div className="mt-6 flex items-center justify-between">
              <Button
                variant="outline"
                disabled={data.offset === 0}
                onClick={() => navigate({ offset: String(Math.max(0, data.offset - data.limit)) })}
              >
                上一页
              </Button>
              <span className="text-xs text-muted-foreground">
                {data.offset + 1}–{Math.min(data.total, data.offset + data.limit)} / {data.total}
              </span>
              <Button
                variant="outline"
                disabled={data.offset + data.limit >= data.total}
                onClick={() => navigate({ offset: String(data.offset + data.limit) })}
              >
                下一页
              </Button>
            </div>
          ) : null}
        </TabsContent>
        <TabsContent value="groups">
          <PurchaseGroupsView groups={groups} categories={categories} />
        </TabsContent>
      </Tabs>
      <FormSheet
        title={createMode === "advanced" ? "分录 / 拆分编辑" : "记一笔"}
        description="保存前检查金额、账户和日期。"
        open={createMode !== null}
        onOpenChange={(open) => {
          if (!open) setCreateMode(null);
        }}
      >
        <div className="mb-3 flex gap-2">
          <Button
            variant={createMode === "quick" ? "default" : "outline"}
            size="sm"
            onClick={() => setCreateMode("quick")}
          >
            快速录入
          </Button>
          <Button
            variant={createMode === "advanced" ? "default" : "outline"}
            size="sm"
            onClick={() => setCreateMode("advanced")}
          >
            分录 / 拆分
          </Button>
        </div>
        {createMode === "quick" ? (
          <QuickEntry
            accounts={accounts}
            categories={categories}
            groups={groups}
            today={today}
            prepaymentMode={settings.prepaymentMode}
            onSaved={() => setCreateMode(null)}
          />
        ) : createMode === "advanced" ? (
          <SplitEditor
            accounts={accounts}
            categories={categories}
            today={today}
            onSaved={() => setCreateMode(null)}
          />
        ) : null}
      </FormSheet>
      <FormSheet
        title="流水详情"
        description="查看分录来源、关联购买和修改记录。"
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      >
        {detail ? (
          <EntryDetailView
            key={detail.id}
            entry={detail}
            accounts={accounts}
            categories={categories}
            groups={groups}
            today={today}
            onSaved={() => setDetail(null)}
          />
        ) : null}
      </FormSheet>
    </>
  );
}
