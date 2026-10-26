"use client";
import { useState } from "react";
import { Field, SelectField } from "@/components/ledger/forms";
import { accountLabels, type AccountType } from "@/lib/ledger/constants";

export function readNewAccount(data: FormData, prefix: string) {
  return {
    name: String(data.get(`${prefix}:name`) ?? ""),
    type: String(data.get(`${prefix}:type`) ?? ""),
    currency: String(data.get(`${prefix}:currency`) ?? ""),
    last4: String(data.get(`${prefix}:last4`) ?? "") || null,
  };
}

export function NewAccountFields({
  prefix,
  name,
  type,
  currency,
  last4,
  types = [type],
  investment = false,
}: {
  prefix: string;
  name: string;
  type: AccountType;
  currency: string;
  last4: string | null;
  types?: AccountType[];
  investment?: boolean;
}) {
  const [selectedType, setType] = useState(type);
  const [selectedCurrency, setCurrency] = useState(currency);
  return (
    <div className="space-y-4 rounded-lg border bg-background p-4">
      <Field label="新账户名称" name={`${prefix}:name`} defaultValue={name} maxLength={100} required />
      <div className="grid grid-cols-2 gap-3">
        <SelectField
          label="账户类型"
          name={`${prefix}:type`}
          value={selectedType}
          onChange={(event) => setType(event.target.value as AccountType)}
        >
          {types.map((value) => (
            <option key={value} value={value}>
              {accountLabels[value]}
            </option>
          ))}
        </SelectField>
        <Field
          label="币种"
          name={`${prefix}:currency`}
          value={selectedCurrency}
          onChange={(event) => setCurrency(event.target.value.toUpperCase())}
          pattern="[A-Z]{3}"
          maxLength={3}
          required
        />
        <Field
          label="卡号尾号（4–5 位）"
          name={`${prefix}:last4`}
          defaultValue={last4 ?? ""}
          pattern="[0-9]{4,5}"
          maxLength={5}
          inputMode="numeric"
        />
      </div>
      {investment ? (
        <p className="text-xs leading-6 text-muted-foreground">
          同时新建同名「持仓」证券账户，用于记录市值。
        </p>
      ) : null}
    </div>
  );
}
