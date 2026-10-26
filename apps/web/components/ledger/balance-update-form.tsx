"use client";
import { useState } from "react";
import Link from "next/link";
import type { BalanceTracking } from "@/lib/ledger/balance-tracking";
import type { Account } from "./types";
import type { FxRate } from "@/components/snapshots/types";
import { Button } from "@/components/ui/button";
import { Field, SelectField, FormError, api, textField, useLedgerMutation } from "./forms";

export function BalanceControls({
  account,
  tracking,
  today,
  timezone,
  baseCurrency,
  rates,
  syncIntervalHours,
}: {
  account: Account;
  tracking: BalanceTracking;
  today: string;
  timezone: string;
  baseCurrency: string;
  rates: FxRate[];
  syncIntervalHours: number;
}) {
  const reminder = useLedgerMutation();
  if (tracking.plaidSynced) {
    const time = tracking.lastSyncedAt
      ? new Intl.DateTimeFormat("zh-CN", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(new Date(tracking.lastSyncedAt))
      : "尚未同步";
    return (
      <p className="text-xs leading-6 text-muted-foreground">
        Plaid 每 {syncIntervalHours} 小时自动同步 · 上次 {time}
      </p>
    );
  }
  if (!tracking.manual) return null;
  return (
    <section aria-label="余额更新" className="space-y-4 border-t pt-4">
      <BalanceUpdateForm account={account} today={today} baseCurrency={baseCurrency} rates={rates} />
      <SelectField
        label="余额更新提醒"
        value={tracking.balanceReminderDays ?? "off"}
        disabled={reminder.pending}
        onChange={(event) => {
          const days = event.target.value === "off" ? null : Number(event.target.value);
          void reminder.run(async () => {
            await api(`/api/accounts/${account.id}`, "PATCH", { balanceReminderDays: days });
          });
        }}
      >
        <option value="off">不提醒</option>
        <option value="1">每天</option>
        {[3, 7, 14, 30].map((days) => (
          <option key={days} value={days}>
            每 {days} 天
          </option>
        ))}
      </SelectField>
      <FormError error={reminder.error} />
    </section>
  );
}

export function BalanceUpdateForm({
  account,
  today,
  baseCurrency,
  rates,
}: {
  account: Account;
  today: string;
  baseCurrency: string;
  rates: FxRate[];
}) {
  const [date, setDate] = useState(today);
  const mutation = useLedgerMutation();
  const security = account.type === "asset_security";
  const foreign = account.currency !== baseCurrency;
  const catalog = rates
    .filter(
      (rate) =>
        rate.baseCurrency === baseCurrency &&
        rate.quoteCurrency === account.currency &&
        rate.observedOn <= date,
    )
    .sort((a, b) => b.observedOn.localeCompare(a.observedOn))[0];
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        void mutation.run(
          async () => {
            await api(`/api/accounts/${account.id}/balance`, "POST", {
              amount: textField(data, "amount"),
              date,
              ...(foreign && textField(data, "rate")
                ? {
                    fx: {
                      rate: textField(data, "rate"),
                      observedOn: textField(data, "observedOn"),
                      source: textField(data, "source") || "手工观察",
                    },
                  }
                : {}),
            });
            form.reset();
          },
          security ? "市值已更新" : "余额已更新",
        );
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field
          name="amount"
          label={`${security ? "市值" : "余额"} · ${account.currency}`}
          inputMode="decimal"
          required
          autoComplete="off"
        />
        <Field
          name="date"
          label="日期"
          type="date"
          value={date}
          max={today}
          onChange={(event) => setDate(event.target.value)}
          required
        />
      </div>
      {account.type.startsWith("liability_") ? (
        <p className="text-xs text-muted-foreground">欠款填负数，溢缴款填正数。</p>
      ) : null}
      {foreign ? (
        <details key={date} open={!catalog} className="rounded-lg border p-3 text-xs">
          <summary className="cursor-pointer leading-6">
            汇率 · {baseCurrency}/{account.currency}
            {catalog ? ` · ${catalog.rate}（${catalog.observedOn}）` : " · 请补充"}
          </summary>
          <div className="mt-3 space-y-3">
            <Field
              name="rate"
              label={`每 1 ${baseCurrency} 对应的 ${account.currency}`}
              inputMode="decimal"
              defaultValue={catalog?.rate ?? ""}
            />
            <Field
              name="observedOn"
              label="汇率日期"
              type="date"
              max={date}
              defaultValue={catalog?.observedOn ?? date}
            />
            <Field name="source" label="来源" defaultValue={catalog?.source ?? "手工观察"} maxLength={200} />
            <p className="leading-6 text-muted-foreground">
              留空时使用不晚于所选日期的目录汇率；缺少汇率无法保存。
              <Link href="/settings/fx" className="text-primary underline">
                管理汇率
              </Link>
            </p>
          </div>
        </details>
      ) : null}
      <FormError error={mutation.error} />
      <Button type="submit" size="sm" disabled={mutation.pending}>
        {mutation.pending ? "正在保存…" : security ? "更新市值" : "更新余额"}
      </Button>
    </form>
  );
}
