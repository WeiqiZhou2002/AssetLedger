"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, SelectField, FormError, api, useLedgerMutation } from "@/components/ledger/forms";
import { NewAccountFields, readNewAccount } from "@/components/imports/new-account-fields";
import { importedAccountName, uniqueAccountName, plaidLedgerType } from "@/lib/imports/account-defaults";
import type { Account } from "@/components/ledger/types";
import type { JsonSafe } from "@/lib/serialization";
import type { listConnections } from "@/lib/bank-sync/connections";
type Connection = JsonSafe<Awaited<ReturnType<typeof listConnections>>>[number];
const NEW_ACCOUNT = "new";

export function MappingForm({ connection, accounts }: { connection: Connection; accounts: Account[] }) {
  const mutation = useLedgerMutation();
  const [from, setFrom] = useState(connection.importFromDate);
  return (
    <form
      className="space-y-4 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void mutation.run(async () => {
          await api(`/api/plaid/connections/${connection.id}/mapping`, "POST", {
            importFromDate: data.get("from"),
            accounts: connection.accounts.map((row) => ({
              id: row.id,
              ...(data.get(`account:${row.id}`) === NEW_ACCOUNT
                ? { create: readNewAccount(data, row.id) }
                : {
                    accountId: data.get(`account:${row.id}`) || null,
                    securityAccountId: data.get(`security:${row.id}`) || null,
                  }),
              isEnabled: data.get(`enabled:${row.id}`) === "on",
            })),
          });
        }, "账户与映射已保存，同步已排队");
      }}
    >
      <Field
        label="导入起始日期（首次同步后固定）"
        name="from"
        type="date"
        value={from}
        onChange={(event) => setFrom(event.target.value)}
        readOnly={Boolean(connection.lastSuccessAt)}
        required
      />
      <p className="text-xs text-muted-foreground">
        按配置的历史起点导入。首次成功后可通过补导历史流水调整。
      </p>
      {connection.accounts.map((bank) => (
        <MappingRow key={bank.id} bank={bank} connection={connection} accounts={accounts} />
      ))}
      {!connection.accounts.length ? <p className="text-sm">账户读取尚未完成，请重新授权后重试。</p> : null}
      <p className="text-xs leading-6 text-muted-foreground">
        按尾号、类型和币种建议匹配，请逐项确认。已确认映射不可改绑；停用账户不再导入交易。
      </p>
      <Button type="submit" disabled={mutation.pending || !connection.accounts.length}>
        确认映射并同步
      </Button>
      <FormError error={mutation.error} />
    </form>
  );
}

function MappingRow({
  bank,
  connection,
  accounts,
}: {
  bank: Connection["accounts"][number];
  connection: Connection;
  accounts: Account[];
}) {
  const type = plaidLedgerType(bank.type);
  const compatible = (value: string) =>
    accounts.filter(
      (row) => row.isActive && !row.isSystem && row.type === value && row.currency === bank.currency,
    );
  const options = compatible(type ?? "");
  const suggested = options.find((account) => bank.mask && account.last4 === bank.mask);
  const [selected, setSelected] = useState(bank.accountId ?? suggested?.id ?? "");
  const [enabled, setEnabled] = useState(bank.isEnabled);
  const creating = selected === NEW_ACCOUNT;
  const locked = Boolean(connection.mappingConfirmedAt && bank.accountId);
  const last4 = bank.mask && /^\d{4}$/.test(bank.mask) ? bank.mask : null;
  const name = uniqueAccountName(
    importedAccountName(connection.institutionName, bank.officialName ?? bank.name, last4),
    accounts.map((row) => row.name),
  );
  return (
    <div className="space-y-3 rounded-lg bg-muted/40 p-4">
      <p className="text-sm break-words">
        {bank.name} · {bank.mask ? `尾号 ${bank.mask}` : "无尾号"} · {bank.currency ?? "不支持的币种"}
      </p>
      {bank.importFromDate ? (
        <p className="text-xs text-muted-foreground">此账户生效起始日：{bank.importFromDate}</p>
      ) : null}
      {bank.type === "loan" ? <p className="text-xs text-muted-foreground">贷款账户仅同步余额</p> : null}
      <SelectField
        name={locked ? undefined : `account:${bank.id}`}
        label={bank.type === "investment" ? "对应券商现金账户" : "对应账本账户"}
        value={selected}
        disabled={locked}
        onChange={(event) => {
          setSelected(event.target.value);
          setEnabled(Boolean(event.target.value));
        }}
      >
        <option value="">暂不导入</option>
        {type && bank.currency ? <option value={NEW_ACCOUNT}>新建账户</option> : null}
        {options.map((row) => (
          <option key={row.id} value={row.id}>
            {row.name}
          </option>
        ))}
      </SelectField>
      {locked ? <input type="hidden" name={`account:${bank.id}`} value={bank.accountId ?? ""} /> : null}
      {creating && type && bank.currency ? (
        <>
          <NewAccountFields
            prefix={bank.id}
            name={name}
            type={type}
            currency={bank.currency}
            last4={last4}
            investment={bank.type === "investment"}
          />
          <p className="text-xs text-muted-foreground">
            机构：{connection.institutionName}；保存时复用或新建。
          </p>
        </>
      ) : null}
      {bank.type === "investment" && !creating ? (
        <>
          <SelectField
            name={locked ? undefined : `security:${bank.id}`}
            label="对应证券市值账户"
            defaultValue={bank.securityAccountId ?? ""}
            disabled={locked}
          >
            <option value="">请选择证券账户</option>
            {compatible("asset_security").map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </SelectField>
          {locked ? (
            <input type="hidden" name={`security:${bank.id}`} value={bank.securityAccountId ?? ""} />
          ) : null}
        </>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <input
          name={`enabled:${bank.id}`}
          type="checkbox"
          checked={enabled}
          disabled={!selected}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        启用此账户同步
      </label>
      {["loan", "investment"].includes(bank.type) ? (
        <p className="text-xs leading-6 text-muted-foreground">
          此账户仅同步余额，期间借还款或投资资金变动需人工核对。
        </p>
      ) : null}
    </div>
  );
}
