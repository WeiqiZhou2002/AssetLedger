"use client";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { accountLabels, entryLabels, entryTypes, systemTypes, type EntryType } from "@/lib/ledger/constants";
import { money } from "@/lib/money";
import { formatAmount } from "@/lib/ledger/format";
import type { Account, Category, EntryDetail } from "./types";
import { Field, FormError, NotesField, SelectField, api, textField, useLedgerMutation } from "./forms";
type Line = { key: string; accountId: string; amount: string; categoryId: string };
export function SplitEditor({
  accounts,
  categories,
  today,
  initial,
  onSaved,
}: {
  accounts: Account[];
  categories: Category[];
  today: string;
  initial?: EntryDetail;
  onSaved: () => void;
}) {
  const [type, setType] = useState<EntryType>(initial?.entryType ?? "expense");
  const [lines, setLines] = useState<Line[]>(() =>
    initial
      ? initial.postings.map((line) => ({
          key: line.id,
          accountId: line.accountId,
          amount: line.amount,
          categoryId: line.categoryId ?? "",
        }))
      : [
          { key: "first", accountId: "", amount: "", categoryId: "" },
          { key: "second", accountId: "", amount: "", categoryId: "" },
        ],
  );
  const mutation = useLedgerMutation();
  const currencies = [
    ...new Set(accounts.filter((account) => !account.isSystem).map((account) => account.currency)),
  ];
  const resolve = (id: string) =>
    id.startsWith("system:")
      ? { type: id.split(":")[1], currency: id.split(":")[2] }
      : accounts.find((account) => account.id === id);
  const totals: Record<string, string> = {};
  let validAmounts = true;
  for (const line of lines) {
    const account = resolve(line.accountId);
    try {
      if (!account || !line.amount || money(line.amount).isZero()) {
        validAmounts = false;
        continue;
      }
      totals[account.currency] = money(totals[account.currency] ?? "0")
        .plus(money(line.amount))
        .toFixed(4);
    } catch {
      validAmounts = false;
    }
  }
  const balanced =
    validAmounts && lines.length >= 2 && Object.values(totals).every((value) => money(value).isZero());
  const update = (key: string, values: Partial<Line>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...values } : line)));
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void mutation.run(async () => {
          const resolved = new Map<string, Account>();
          for (const line of lines) {
            if (line.accountId.startsWith("system:") && !resolved.has(line.accountId)) {
              const [, type, currency] = line.accountId.split(":");
              resolved.set(
                line.accountId,
                await api<Account>("/api/system-accounts", "POST", { type, currency }),
              );
            }
          }
          const entry = {
            entryType: type,
            isSummary: data.get("isSummary") === "on",
            status: textField(data, "status"),
            eventDate: textField(data, "eventDate"),
            postedDate: textField(data, "postedDate") || null,
            merchant: textField(data, "merchant") || null,
            description: textField(data, "description") || null,
            notes: textField(data, "notes") || null,
            purchaseGroupId: initial?.purchaseGroupId ?? null,
            refundOfEntryId: type === "refund" ? (initial?.refundOfEntryId ?? null) : null,
            postings: lines.map((line) => ({
              accountId: resolved.get(line.accountId)?.id ?? line.accountId,
              amount: line.amount,
              currency: resolve(line.accountId)!.currency,
              categoryId: line.categoryId || null,
            })),
          };
          await api(
            initial ? `/api/transactions/${initial.id}/replace` : "/api/transactions",
            "POST",
            initial ? { reason: textField(data, "reason"), entry } : { mode: "advanced", input: entry },
          );
          onSaved();
        });
      }}
    >
      <SelectField
        label="交易类型"
        value={type}
        onChange={(event) => setType(event.target.value as EntryType)}
      >
        {entryTypes.map((value) => (
          <option key={value} value={value}>
            {entryLabels[value]}
          </option>
        ))}
      </SelectField>
      <p className="text-xs leading-6 text-muted-foreground">
        借方为正、贷方为负，每个币种分别合计为零。消费的支出科目为正，付款账户为负；退款方向相反。
      </p>
      {lines.map((line, index) => {
        const account = resolve(line.accountId);
        return (
          <div key={line.key} className="space-y-3 rounded-xl border bg-card p-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>分录 {index + 1}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`移除分录 ${index + 1}`}
                disabled={lines.length <= 2}
                onClick={() => setLines((current) => current.filter((row) => row.key !== line.key))}
              >
                <Trash2 size={14} />
              </Button>
            </div>
            <SelectField
              label="账户 / 收支科目"
              value={line.accountId}
              required
              onChange={(event) => update(line.key, { accountId: event.target.value, categoryId: "" })}
            >
              <option value="">选择账户或科目</option>
              {accounts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.currency}
                  {!item.isActive ? "（停用）" : ""}
                </option>
              ))}
              {currencies.flatMap((currency) =>
                systemTypes
                  .filter(
                    (type) =>
                      !accounts.some(
                        (account) =>
                          account.isSystem && account.type === type && account.currency === currency,
                      ),
                  )
                  .map((type) => (
                    <option key={`${type}:${currency}`} value={`system:${type}:${currency}`}>
                      {accountLabels[type]} · {currency}
                    </option>
                  )),
              )}
            </SelectField>
            <Field
              label={`有符号金额${account ? `（${account.currency}）` : ""}`}
              inputMode="decimal"
              value={line.amount}
              required
              onChange={(event) => update(line.key, { amount: event.target.value })}
            />
            {account && ["expense", "income"].includes(account.type) ? (
              <SelectField
                label="分类"
                value={line.categoryId}
                required
                onChange={(event) => update(line.key, { categoryId: event.target.value })}
              >
                <option value="">选择分类</option>
                {categories
                  .filter((item) => !item.isArchived && item.kind === account.type)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </SelectField>
            ) : null}
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        disabled={lines.length >= 100}
        onClick={() =>
          setLines((current) => [
            ...current,
            { key: crypto.randomUUID(), accountId: "", amount: "", categoryId: "" },
          ])
        }
      >
        <Plus size={15} />
        添加分录
      </Button>
      <div className="rounded-lg bg-muted p-3 text-sm">
        <p>{balanced ? "逐币种已平衡" : "请补全分录，并使每个币种合计为零"}</p>
        {Object.entries(totals).map(([currency, value]) => (
          <p key={currency} className="mt-1 font-mono text-xs">
            {formatAmount(value, currency)}
          </p>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field
          name="eventDate"
          label="发生日期"
          type="date"
          defaultValue={initial?.eventDate ?? today}
          required
        />
        <Field name="postedDate" label="入账日期" type="date" defaultValue={initial?.postedDate ?? ""} />
      </div>
      <Field name="merchant" label="商户 / 对方" defaultValue={initial?.merchant ?? ""} maxLength={200} />
      <Field name="description" label="说明" defaultValue={initial?.description ?? ""} maxLength={2000} />
      <NotesField
        name="notes"
        label={type === "balance_adjustment" ? "调整原因（必填）" : "备注"}
        defaultValue={initial?.notes ?? ""}
        required={type === "balance_adjustment"}
      />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="isSummary" defaultChecked={initial?.isSummary ?? false} />
        汇总录入（缺少逐笔明细，已核实合计）
      </label>
      {initial ? <Field name="reason" label="替换原因" required maxLength={2000} /> : null}
      <SelectField
        name="status"
        label="保存为"
        defaultValue={initial?.status === "draft" ? "draft" : "confirmed"}
      >
        <option value="confirmed">已确认</option>
        <option value="draft">草稿</option>
      </SelectField>
      <FormError error={mutation.error} />
      <Button type="submit" disabled={mutation.pending || !balanced} className="w-full">
        {mutation.pending ? "正在保存…" : initial ? "作废原流水并创建替换" : "保存分录"}
      </Button>
    </form>
  );
}
