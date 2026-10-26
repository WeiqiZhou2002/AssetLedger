"use client";
import { accountTileGrid, accountTileClass } from "./account-tile";
import { BalanceControls } from "./balance-update-form";
import type { BalanceTracking } from "@/lib/ledger/balance-tracking";
import type { FxRate } from "@/components/snapshots/types";
import { InlineMoney, MoneyAmount } from "@/components/money-amount";
import { money } from "@/lib/money";
import type { AccountPosition } from "@/lib/ledger/observed-balances";
import Link from "next/link";
import type { AccountGroup } from "@/components/snapshots/types";
import { useState } from "react";
import { Plus, Pencil, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { accountLabels, realTypes } from "@/lib/ledger/constants";
import { AccountForm } from "./account-form";
import { AccountCard } from "./account-card";
import { AccountRecent } from "./account-recent";
import type { CardMeta } from "@/lib/ledger/card-secrets";
import { FormError, FormSheet, api, useLedgerMutation } from "./forms";
import type { AccountBalance, Institution } from "./types";

type Position = Pick<AccountPosition, "observed" | "difference"> & { accountId: string };

function observationLabel(observed: Position["observed"], timezone: string, compact = false) {
  if (!observed) return "账本";
  const date = compact ? observed.date.slice(5) : observed.date;
  if (observed.source !== "plaid") return `${observed.source === "statement" ? "账单" : "手工"} ${date}`;
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(observed.observedAt));
  return `Plaid ${date} ${time}`;
}

export function AccountsView({
  accounts,
  institutions,
  groups,
  today,
  benefits = [],
  positions = [],
  timezone = "UTC",
  cards = [],
  totpEnabled = false,
  tracking = [],
  baseCurrency = "USD",
  rates = [],
  syncIntervalHours = 12,
}: {
  accounts: AccountBalance[];
  institutions: Institution[];
  groups: AccountGroup[];
  today: string;
  positions?: Position[];
  timezone?: string;
  cards?: CardMeta[];
  totpEnabled?: boolean;
  tracking?: BalanceTracking[];
  baseCurrency?: string;
  rates?: FxRate[];
  syncIntervalHours?: number;
  benefits?: { accountId: string; annual: string; rolling: string }[];
}) {
  const [editing, setEditing] = useState<AccountBalance | "new" | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = accounts.find((account) => account.id === detailId);
  const detailPosition = positions.find((position) => position.accountId === detailId);
  const detailBenefit = benefits.find((benefit) => benefit.accountId === detailId);
  const detailTracking = tracking.find((row) => row.accountId === detailId);
  const mutation = useLedgerMutation();
  return (
    <>
      <div className="mb-6 flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {accounts.length ? `${accounts.length} 个账户 · 截至 ${today}` : "添加账户，开始记录真实余额"}
        </p>
        <Button onClick={() => setEditing("new")}>
          <Plus size={16} />
          新增账户
        </Button>
      </div>
      {!accounts.length ? (
        <section className="rounded-2xl border bg-card p-8">
          <Wallet className="mb-4 text-primary" />
          <h2 className="font-medium">第一个账户，从这里入册</h2>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">
            先填写名称和币种，连接银行同步余额，或在账户详情更新余额。信用卡欠款请填写负数。
          </p>
        </section>
      ) : (
        realTypes.map((type) => {
          const group = accounts.filter((account) => account.type === type);
          return group.length ? (
            <section key={type} className="mb-8">
              <h2 className="mb-3 text-sm font-medium text-muted-foreground">{accountLabels[type]}</h2>
              <div className={accountTileGrid}>
                {group.map((account) => {
                  const observed = positions.find((row) => row.accountId === account.id)?.observed ?? null;
                  const subline = [
                    institutions.find((institution) => institution.id === account.institutionId)?.name,
                    account.last4 ? `•••• ${account.last4}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <button
                      type="button"
                      id={`account-${account.id}`}
                      key={account.id}
                      aria-label={`查看 ${account.name} 详情`}
                      onClick={() => setDetailId(account.id)}
                      className={accountTileClass}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium" title={account.name}>
                          {account.name}
                        </span>
                        {tracking.find((row) => row.accountId === account.id)?.reminderDue ? (
                          <Badge variant="outline" className="shrink-0 text-[0.625rem]">
                            待更新
                          </Badge>
                        ) : null}
                        {!account.isActive ? (
                          <Badge variant="secondary" className="shrink-0 text-[0.625rem]">
                            已停用
                          </Badge>
                        ) : null}
                      </span>
                      {subline ? (
                        <span className="mt-1 block truncate text-xs text-muted-foreground" title={subline}>
                          {subline}
                        </span>
                      ) : null}
                      <span className="mt-3 block">
                        <MoneyAmount
                          value={observed?.amount ?? account.balance}
                          currency={account.currency}
                        />
                      </span>
                      <span
                        className="mt-1 block text-[0.625rem] text-muted-foreground"
                        title={observationLabel(observed, timezone)}
                      >
                        {observationLabel(observed, timezone, true)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null;
        })
      )}
      <p className="text-xs leading-6 text-muted-foreground">
        优先显示最新银行或手工余额；账本余额仅汇总已确认流水。信用卡负数表示欠款，正数表示溢缴；证券账本余额为净现金投入，不是当前市值。
      </p>
      <FormSheet
        title={detail?.name ?? "账户详情"}
        description="查看余额、卡片信息与账户设置。"
        open={Boolean(detail)}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
      >
        {detail ? (
          <div key={detail.id} className="min-w-0 space-y-5">
            <section aria-label="余额" className="space-y-3">
              <h3 className="text-sm font-medium">余额</h3>
              {detailPosition?.observed ? (
                <div>
                  <p className="mb-2 text-xs text-muted-foreground">
                    {detailPosition.observed.source === "plaid" ? "银行余额" : "观察余额"}
                  </p>
                  <MoneyAmount value={detailPosition.observed.amount} currency={detail.currency} />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {observationLabel(detailPosition.observed, timezone)}
                  </p>
                </div>
              ) : null}
              <p className="text-sm text-muted-foreground">
                账本余额 <InlineMoney value={detail.balance} currency={detail.currency} />
              </p>
              {detailPosition?.difference && !money(detailPosition.difference).isZero() ? (
                <p className="text-xs leading-6 text-muted-foreground">
                  账本比观察{money(detailPosition.difference).lt(0) ? "少" : "多"}{" "}
                  <InlineMoney
                    value={money(detailPosition.difference).abs().toFixed(4)}
                    currency={detail.currency}
                  />{" "}
                </p>
              ) : null}
            </section>
            {detailTracking ? (
              <BalanceControls
                account={detail}
                tracking={detailTracking}
                today={today}
                timezone={timezone}
                baseCurrency={baseCurrency}
                rates={rates}
                syncIntervalHours={syncIntervalHours}
              />
            ) : null}
            <AccountCard
              account={detail}
              meta={cards.find((card) => card.accountId === detail.id)}
              totpEnabled={totpEnabled}
            />
            {detail.type === "liability_credit_card" ? (
              <section aria-label="卡权益返还" className="space-y-3 border-t pt-4">
                <h3 className="text-sm font-medium">卡权益返还</h3>
                <Link href="/benefits" className="block text-xs leading-6 text-primary">
                  本年 <InlineMoney value={detailBenefit?.annual ?? "0"} currency={detail.currency} /> · 近 12
                  月 <InlineMoney value={detailBenefit?.rolling ?? "0"} currency={detail.currency} />
                </Link>
              </section>
            ) : null}
            <AccountRecent key={detail.id} accountId={detail.id} />
            <div className="flex flex-wrap gap-2 border-t pt-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setDetailId(null);
                  setEditing(detail);
                }}
              >
                <Pencil size={15} />
                编辑账户
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={mutation.pending}
                onClick={() =>
                  mutation.run(async () => {
                    await api(`/api/accounts/${detail.id}`, "PATCH", { isActive: !detail.isActive });
                  })
                }
              >
                {detail.isActive ? "停用" : "重新启用"}
              </Button>
            </div>
            <FormError error={mutation.error} />
          </div>
        ) : null}
      </FormSheet>
      <FormSheet
        title={editing === "new" ? "新增账户" : "编辑账户"}
        description="账户资料使用尾号；点击账户后可在详情中单独保存完整卡片信息。"
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing ? (
          <AccountForm
            key={editing === "new" ? "new" : editing.id}
            account={editing === "new" ? undefined : editing}
            institutions={institutions}
            groups={groups}
            onSaved={() => setEditing(null)}
          />
        ) : null}
      </FormSheet>
    </>
  );
}
