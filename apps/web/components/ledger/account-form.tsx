"use client";
import type { AccountGroup } from "@/components/snapshots/types";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { accountLabels, realTypes, type AccountType } from "@/lib/ledger/constants";
import { Field, FormError, NotesField, SelectField, api, textField, useLedgerMutation } from "./forms";
import type { Account, Institution } from "./types";
export function AccountForm({
  account,
  institutions,
  groups = [],
  onSaved,
}: {
  account?: Account;
  institutions: Institution[];
  groups?: AccountGroup[];
  onSaved: () => void;
}) {
  const [institutionId, setInstitutionId] = useState(account?.institutionId ?? "");
  const mutation = useLedgerMutation();
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await mutation.run(async () => {
      const optionalDay = (name: string) => (textField(data, name) ? Number(textField(data, name)) : null);
      const values = {
        name: textField(data, "name"),
        type: textField(data, "type") as AccountType,
        currency: textField(data, "currency").toUpperCase(),
        institutionId: institutionId && institutionId !== "new" ? institutionId : null,
        ...(institutionId === "new"
          ? {
              institution: {
                name: textField(data, "institutionName"),
                kind: textField(data, "institutionKind"),
              },
            }
          : {}),
        accountGroupId: textField(data, "accountGroupId") || null,
        last4: textField(data, "last4") || null,
        notes: textField(data, "notes") || null,
        openedOn: textField(data, "openedOn") || null,
        closedOn: textField(data, "closedOn") || null,
        statementDay: optionalDay("statementDay"),
        paymentDueDay: optionalDay("paymentDueDay"),
        ...(account
          ? {
              isActive: data.has("isActive"),
            }
          : {}),
      };
      await api(
        account ? `/api/accounts/${account.id}` : "/api/accounts",
        account ? "PATCH" : "POST",
        values,
      );
      onSaved();
    });
  }
  return (
    <form onSubmit={submit} className="space-y-5">
      <Field name="name" label="账户名称" defaultValue={account?.name} maxLength={100} required />
      <div className="grid grid-cols-2 gap-3">
        <SelectField name="type" label="账户类型" defaultValue={account?.type ?? "asset_cash"}>
          {realTypes.map((type) => (
            <option key={type} value={type}>
              {accountLabels[type]}
            </option>
          ))}
        </SelectField>
        <Field
          name="currency"
          label="币种"
          defaultValue={account?.currency ?? "USD"}
          pattern="[A-Za-z]{3}"
          maxLength={3}
          required
        />
      </div>
      <SelectField
        label="所属机构"
        value={institutionId}
        onChange={(event) => setInstitutionId(event.target.value)}
      >
        <option value="">不指定机构</option>
        {institutions.map((institution) => (
          <option key={institution.id} value={institution.id}>
            {institution.name}
          </option>
        ))}
        <option value="new">＋ 新增机构</option>
      </SelectField>
      {institutionId === "new" ? (
        <div className="grid gap-3 rounded-lg bg-muted p-4">
          <Field name="institutionName" label="机构名称" maxLength={100} required />
          <SelectField name="institutionKind" label="机构类型">
            <option value="bank">银行</option>
            <option value="card_issuer">发卡机构</option>
            <option value="brokerage">券商</option>
            <option value="wallet">钱包</option>
            <option value="other">其他</option>
          </SelectField>
        </div>
      ) : null}
      <SelectField name="accountGroupId" label="账户组" defaultValue={account?.accountGroupId ?? ""}>
        <option value="">不分组</option>
        {groups.map((group) => (
          <option key={group.id} value={group.id}>
            {group.name} · {group.currency}
          </option>
        ))}
      </SelectField>
      <Field
        name="last4"
        label="卡号尾号（4–5 位）"
        defaultValue={account?.last4 ?? ""}
        pattern="[0-9]{4,5}"
        maxLength={5}
        inputMode="numeric"
      />
      <div className="grid grid-cols-2 gap-3">
        <Field name="openedOn" label="开户日期" type="date" defaultValue={account?.openedOn ?? ""} />
        <Field name="closedOn" label="关闭日期" type="date" defaultValue={account?.closedOn ?? ""} />
        <Field
          name="statementDay"
          label="账单日（每月）"
          type="number"
          min={1}
          max={31}
          defaultValue={account?.statementDay ?? ""}
        />
        <Field
          name="paymentDueDay"
          label="还款日（每月）"
          type="number"
          min={1}
          max={31}
          defaultValue={account?.paymentDueDay ?? ""}
        />
      </div>
      {account ? (
        <div className="space-y-4 rounded-lg border p-4">
          <label className="flex items-center gap-3 text-sm">
            <input name="isActive" type="checkbox" defaultChecked={account.isActive} />
            启用账户
          </label>
        </div>
      ) : null}
      <NotesField name="notes" defaultValue={account?.notes ?? ""} />
      <FormError error={mutation.error} />
      <Button disabled={mutation.pending} type="submit" className="w-full">
        {mutation.pending ? "正在保存…" : "保存账户"}
      </Button>
    </form>
  );
}
