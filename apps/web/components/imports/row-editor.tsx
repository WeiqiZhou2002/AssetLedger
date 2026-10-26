"use client";
import { Button } from "@/components/ui/button";
import {
  Field,
  FormError,
  NotesField,
  SelectField,
  api,
  textField,
  useLedgerMutation,
} from "@/components/ledger/forms";
import { entryLabels, entryTypes } from "@/lib/ledger/constants";
import type { Account, Category } from "@/components/ledger/types";
import type { ImportRow } from "./types";
export function RowEditor({
  row,
  accounts,
  categories,
  onSaved,
}: {
  row: ImportRow;
  accounts: Account[];
  categories: Category[];
  onSaved: () => void;
}) {
  const mutation = useLedgerMutation();
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const choice = textField(data, "pair");
        void mutation.run(async () => {
          await api(`/api/statements/${row.statementId}/rows`, "PATCH", {
            rowIds: [row.id],
            changes: {
              transactionDate: textField(data, "transactionDate") || null,
              postedDate: textField(data, "postedDate") || null,
              descriptionRaw: textField(data, "descriptionRaw"),
              merchantNormalized: textField(data, "merchantNormalized"),
              amount: textField(data, "amount"),
              suggestedEntryType: textField(data, "type") || null,
              suggestedCategoryId: textField(data, "category") || null,
              suggestedCounterAccountId: textField(data, "counter") || null,
              duplicateResolution: textField(data, "duplicateResolution"),
              decision: choice.startsWith("entry:") ? "link_existing" : textField(data, "decision"),
              decisionPayload: {
                ...(choice.startsWith("row:")
                  ? { pairRowId: choice.slice(4) }
                  : choice.startsWith("entry:")
                    ? { linkEntryId: choice.slice(6) }
                    : {}),
                notes: textField(data, "notes") || undefined,
              },
            },
          });
          onSaved();
        });
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field type="date" name="transactionDate" label="交易日期" defaultValue={row.transactionDate ?? ""} />
        <Field type="date" name="postedDate" label="入账日期" defaultValue={row.postedDate ?? ""} />
      </div>
      <Field name="descriptionRaw" label="描述" defaultValue={row.descriptionRaw} maxLength={2000} />
      <Field name="merchantNormalized" label="商户" defaultValue={row.merchantNormalized} maxLength={200} />
      <Field
        name="amount"
        label={`账户金额 ${row.currency}（借方 +，贷方 −）`}
        defaultValue={row.amount}
        inputMode="decimal"
        required
      />
      <SelectField name="type" label="交易类型" defaultValue={row.suggestedEntryType ?? ""}>
        <option value="">请选择</option>
        {entryTypes.map((type) => (
          <option key={type} value={type}>
            {entryLabels[type]}
          </option>
        ))}
      </SelectField>
      <SelectField name="category" label="消费 / 收入分类" defaultValue={row.suggestedCategoryId ?? ""}>
        <option value="">请选择</option>
        {categories
          .filter((category) => !category.isArchived)
          .map((category) => (
            <option key={category.id} value={category.id}>
              {category.kind === "expense" ? "支出" : "收入"} · {category.name}
            </option>
          ))}
      </SelectField>
      <SelectField
        name="counter"
        label="对方账户（转账、还卡、投资等）"
        defaultValue={row.suggestedCounterAccountId ?? ""}
      >
        <option value="">不使用 / 待选择</option>
        {accounts
          .filter((account) => account.currency === row.currency)
          .map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
      </SelectField>
      <SelectField
        name="pair"
        label="配对 / 关联已有流水"
        defaultValue={
          row.decisionPayload.pairRowId
            ? `row:${row.decisionPayload.pairRowId}`
            : row.decisionPayload.linkEntryId
              ? `entry:${row.decisionPayload.linkEntryId}`
              : ""
        }
      >
        <option value="">单独处理本行</option>
        {row.pairing.map((pair, i) => (
          <option key={i} value={pair.rowId ? `row:${pair.rowId}` : `entry:${pair.entryId}`}>
            还卡配对 · {accounts.find((account) => account.id === pair.counterAccountId)?.name} ·{" "}
            {(pair.rowId ?? pair.entryId)?.slice(0, 8)}
          </option>
        ))}
        {row.duplicateCandidateEntryIds
          .filter((id) => !row.pairing.some((pair) => pair.entryId === id))
          .map((id) => (
            <option key={id} value={`entry:${id}`}>
              已有流水 · {id.slice(0, 8)}
            </option>
          ))}
      </SelectField>
      <SelectField name="duplicateResolution" label="重复候选判断" defaultValue={row.duplicateResolution}>
        <option value="none">尚未判断</option>
        <option value="distinct">确认为不同交易</option>
        <option value="duplicate">确认为重复（请排除或关联）</option>
      </SelectField>
      <SelectField name="decision" label="审核决定" defaultValue={row.decision}>
        <option value="pending">待审核</option>
        <option value="approve">批准新建流水</option>
        <option value="exclude">排除</option>
        <option value="link_existing">关联所选已有流水</option>
      </SelectField>
      <NotesField name="notes" defaultValue={row.decisionPayload.notes ?? ""} />
      <details>
        <summary className="text-sm">原始行证据 · 第 {row.sourcePage ?? "CSV"} 页</summary>
        <pre className="mt-3 rounded border p-3 text-xs break-all whitespace-pre-wrap">
          {row.sourceRowText}
        </pre>
      </details>
      <p className="text-xs leading-6 text-muted-foreground">
        选择另一账单的还卡配对并批准，会同时关联两侧证据，只创建一笔还款。
      </p>
      <FormError error={mutation.error} />
      <Button type="submit" className="w-full" disabled={mutation.pending}>
        保存审核决定
      </Button>
    </form>
  );
}
