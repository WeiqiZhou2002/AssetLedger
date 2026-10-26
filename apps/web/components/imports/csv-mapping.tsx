"use client";
import { Button } from "@/components/ui/button";
import { Field, SelectField, FormError, api, textField, useLedgerMutation } from "@/components/ledger/forms";
export function CsvMappingForm({
  statementId,
  headers,
  skipRows,
}: {
  statementId: string;
  headers: string[];
  skipRows: number;
}) {
  const mutation = useLedgerMutation();
  const column = (name: string, label: string, required = false) => (
    <SelectField name={name} label={label} required={required} defaultValue="">
      <option value="">请选择 / 不使用</option>
      {headers.map((header) => (
        <option key={header} value={header}>
          {header}
        </option>
      ))}
    </SelectField>
  );
  return (
    <details open className="rounded-xl border bg-card p-5">
      <summary className="cursor-pointer font-medium">CSV 列映射</summary>
      <form
        className="mt-5 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const field = (name: string) => textField(data, name) || undefined;
          void mutation.run(async () => {
            await api(`/api/statements/${statementId}/mapping`, "POST", {
              name: textField(data, "name"),
              mapping: {
                dateColumn: field("dateColumn"),
                dateFormat: field("dateFormat"),
                descriptionColumn: field("descriptionColumn"),
                amountColumn: field("amountColumn"),
                debitColumn: field("debitColumn"),
                creditColumn: field("creditColumn"),
                referenceColumn: field("referenceColumn"),
                signConvention: field("signConvention"),
                skipRows: Number(textField(data, "skipRows")),
              },
            });
          }, "映射已保存，正在重新识别");
        }}
      >
        <Field name="name" label="映射名称" defaultValue="我的账单格式" required />
        <div className="grid gap-4 sm:grid-cols-2">
          {column("dateColumn", "日期列", true)}
          {column("descriptionColumn", "描述列", true)}
          <SelectField name="dateFormat" label="日期格式" defaultValue="MM/DD/YYYY">
            <option>MM/DD/YYYY</option>
            <option>YYYY-MM-DD</option>
            <option>MM/DD/YY</option>
          </SelectField>
          <SelectField name="signConvention" label="单列金额符号" defaultValue="account_signed">
            <option value="account_signed">账户符号：流入 +、流出 −</option>
            <option value="positive_charge">信用卡：正数消费、负数还款/退款</option>
          </SelectField>
          {column("amountColumn", "单列带符号金额")}
          {column("debitColumn", "或：支出 / debit 列")}
          {column("creditColumn", "或：收入 / credit 列")}
          {column("referenceColumn", "银行交易编号列（可选）")}
        </div>
        <Field
          name="skipRows"
          label="表头前跳过行数"
          type="number"
          min="0"
          max="100"
          defaultValue={skipRows}
        />
        <p className="text-xs leading-6 text-muted-foreground">
          单列金额与借贷两列二选一。映射仅在此账户及相同表头复用。
        </p>
        <FormError error={mutation.error} />
        <Button type="submit" disabled={mutation.pending}>
          保存映射并重新识别
        </Button>
      </form>
    </details>
  );
}
