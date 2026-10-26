"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  cashTypes,
  entryLabels,
  entryTypes,
  fundingTypes,
  transferTypes,
  type AccountType,
  type EntryType,
} from "@/lib/ledger/constants";
import { Field, FormError, NotesField, SelectField, api, textField, useLedgerMutation } from "./forms";
import type { Account, Category, Group } from "./types";
function eligible(type: EntryType, side: "from" | "to", incomeInterest: boolean): AccountType[] {
  if (type === "opening_balance" || type === "balance_adjustment") return [];
  if (type === "income") return fundingTypes;
  if (type === "interest" && incomeInterest) return cashTypes;
  if (type === "expense") return [...fundingTypes, "asset_prepaid"];
  if (type === "fee" || type === "interest" || type === "refund") return fundingTypes;
  if (type === "transfer") return transferTypes;
  if (type === "credit_card_payment") return side === "from" ? cashTypes : ["liability_credit_card"];
  if (type === "investment_buy") return side === "from" ? ["asset_brokerage_cash"] : ["asset_security"];
  if (type === "investment_sell") return side === "from" ? ["asset_security"] : ["asset_brokerage_cash"];
  if (type === "loan_out") return side === "from" ? fundingTypes : ["asset_receivable"];
  if (type === "loan_repayment") return side === "from" ? ["asset_receivable"] : cashTypes;
  return side === "from" ? fundingTypes : ["asset_prepaid"];
}
export function QuickEntry({
  accounts,
  categories,
  groups,
  today,
  prepaymentMode,
  onSaved,
}: {
  accounts: Account[];
  categories: Category[];
  groups: Group[];
  today: string;
  prepaymentMode: "asset" | "expense";
  onSaved: () => void;
}) {
  const [type, setType] = useState<EntryType>("expense");
  const [direction, setDirection] = useState("expense");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const mutation = useLedgerMutation();
  const incoming =
    ["income", "refund", "opening_balance", "balance_adjustment"].includes(type) ||
    (type === "interest" && direction === "income");
  const outgoing =
    ["expense", "fee"].includes(type) ||
    (type === "interest" && direction === "expense") ||
    (type === "prepayment" && prepaymentMode === "expense");
  const categoryKind =
    type === "income" || (type === "interest" && direction === "income") ? "income" : "expense";
  const requiresCategory = ["expense", "income", "refund", "fee", "interest"].includes(type);
  const from = accounts.find((account) => account.id === fromId);
  const to = accounts.find((account) => account.id === toId);
  const fx = type === "transfer" && from && to && from.currency !== to.currency;
  const investment = type === "investment_buy" || type === "investment_sell";
  const options = (side: "from" | "to") =>
    accounts.filter(
      (account) =>
        account.isActive &&
        !account.isSystem &&
        (eligible(type, side, direction === "income").length === 0 ||
          eligible(type, side, direction === "income").includes(account.type)),
    );
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void mutation.run(async () => {
          const input = {
            type,
            isSummary: data.get("isSummary") === "on",
            amount: textField(data, "amount"),
            eventDate: textField(data, "eventDate"),
            postedDate: textField(data, "postedDate") || null,
            status: textField(data, "status"),
            merchant: textField(data, "merchant") || null,
            notes: textField(data, "notes") || null,
            fromAccountId: incoming ? null : fromId,
            toAccountId: outgoing ? null : toId,
            categoryId: textField(data, "categoryId") || null,
            interestDirection: direction,
            purchaseGroupId: textField(data, "purchaseGroupId") || null,
            refundOfEntryId: textField(data, "refundOfEntryId") || null,
            ...(fx ? { toAmount: textField(data, "toAmount") } : {}),
            ...(investment && textField(data, "feeAmount")
              ? {
                  feeAmount: textField(data, "feeAmount"),
                  feeCategoryId: textField(data, "feeCategoryId") || null,
                }
              : {}),
          };
          await api("/api/transactions", "POST", { mode: "quick", input });
          onSaved();
        });
      }}
    >
      <SelectField
        label="交易类型"
        value={type}
        onChange={(event) => {
          setType(event.target.value as EntryType);
          setFromId("");
          setToId("");
        }}
      >
        {entryTypes.map((value) => (
          <option key={value} value={value}>
            {entryLabels[value]}
          </option>
        ))}
      </SelectField>
      {type === "interest" ? (
        <SelectField
          label="利息方向"
          value={direction}
          onChange={(event) => {
            setDirection(event.target.value);
            setFromId("");
            setToId("");
          }}
        >
          <option value="expense">利息支出</option>
          <option value="income">利息收入</option>
        </SelectField>
      ) : null}
      {!incoming ? (
        <SelectField
          label="支付 / 转出账户"
          value={fromId}
          onChange={(event) => setFromId(event.target.value)}
          required
        >
          <option value="">选择账户</option>
          {options("from").map((account) => (
            <option key={account.id} value={account.id}>
              {account.name} · {account.currency}
            </option>
          ))}
        </SelectField>
      ) : null}
      {!outgoing ? (
        <SelectField
          label={incoming ? "记入账户" : "收到 / 转入账户"}
          value={toId}
          onChange={(event) => setToId(event.target.value)}
          required
        >
          <option value="">选择账户</option>
          {options("to").map((account) => (
            <option key={account.id} value={account.id}>
              {account.name} · {account.currency}
            </option>
          ))}
        </SelectField>
      ) : null}
      <Field
        name="amount"
        label={`金额${(incoming ? to : from)?.currency ? `（${(incoming ? to : from)?.currency}）` : ""}`}
        inputMode="decimal"
        required
        placeholder={type === "opening_balance" || type === "balance_adjustment" ? "可填正数或负数" : "0.00"}
      />
      {fx ? (
        <Field name="toAmount" label={`实际到账金额（${to.currency}）`} inputMode="decimal" required />
      ) : null}
      {requiresCategory ? (
        <SelectField name="categoryId" label="分类" required>
          <option value="">选择分类</option>
          {categories
            .filter((category) => !category.isArchived && category.kind === categoryKind)
            .map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
        </SelectField>
      ) : null}
      {investment ? (
        <div className="space-y-3 rounded-lg bg-muted p-4">
          <Field name="feeAmount" label="手续费（可不填）" inputMode="decimal" />
          <SelectField name="feeCategoryId" label="手续费分类">
            <option value="">无手续费</option>
            {categories
              .filter((category) => !category.isArchived && category.kind === "expense")
              .map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
          </SelectField>
          <p className="text-xs leading-6 text-muted-foreground">
            金额为证券本金；买入额外支付手续费，卖出从到账款扣除手续费。
          </p>
        </div>
      ) : null}
      {type === "prepayment" ? (
        <p className="rounded-lg bg-muted p-3 text-xs leading-6">
          {prepaymentMode === "asset"
            ? "先记录为预付款资产，后续用消费从预付款账户摊销。"
            : "按当前偏好，直接记为住房租金消费。"}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <Field name="eventDate" label="发生日期" type="date" defaultValue={today} required />
        <Field name="postedDate" label="入账日期（可选）" type="date" />
      </div>
      <Field name="merchant" label="商户 / 对方（可选）" maxLength={200} />
      {["expense", "refund", "fee"].includes(type) || (type === "interest" && direction === "expense") ? (
        <SelectField name="purchaseGroupId" label="购物组（可选）">
          <option value="">不关联</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.title} · {group.currency}
            </option>
          ))}
        </SelectField>
      ) : null}
      {type === "refund" ? (
        <Field name="refundOfEntryId" label="原消费流水 ID（可选，可从详情复制）" />
      ) : null}
      <NotesField
        name="notes"
        label={type === "balance_adjustment" ? "调整原因（必填）" : "备注"}
        required={type === "balance_adjustment"}
      />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="isSummary" />
        汇总录入（缺少逐笔明细，已核实合计）
      </label>
      <SelectField name="status" label="保存为">
        <option value="confirmed">已确认</option>
        <option value="draft">草稿</option>
      </SelectField>
      <FormError error={mutation.error} />
      <Button type="submit" disabled={mutation.pending} className="w-full">
        {mutation.pending ? "正在保存…" : "保存流水"}
      </Button>
    </form>
  );
}
