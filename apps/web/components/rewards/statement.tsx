"use client";
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { FormError, SelectField, api, useLedgerMutation } from "@/components/ledger/forms";
import type { statementRewardsPreview } from "@/lib/rewards/integrations";
import type { JsonSafe } from "@/lib/serialization";
export function StatementRewards({
  statementId,
  preview,
}: {
  statementId: string;
  preview: JsonSafe<Awaited<ReturnType<typeof statementRewardsPreview>>>;
}) {
  const mutation = useLedgerMutation();
  const [accountId, setAccountId] = useState(preview?.accounts.length === 1 ? preview.accounts[0].id : "");
  const [confirmed, setConfirmed] = useState(false);
  if (!preview) return null;
  return (
    <section className="rounded-xl border border-amber-900/15 bg-[#f4eee2] p-5">
      <h2 className="text-sm font-medium">账单积分 · 记录前请核对</h2>
      <p className="mt-3 text-sm leading-7">
        本期获得 {preview.earned} 点 · {preview.as_of} 日终总额 {preview.total} 点。
      </p>
      <p className="mt-1 text-xs leading-6 text-muted-foreground">
        确认后记录积分收入与日终观察，不影响现金账本。
      </p>
      {preview.recorded ? (
        <p className="mt-3 text-sm text-primary">已记录积分，无需重复确认。</p>
      ) : preview.accounts.length ? (
        <div className="mt-4 space-y-4">
          <SelectField
            label="关联积分账户"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
          >
            <option value="">请选择积分账户</option>
            {preview.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </SelectField>
          <label className="flex items-start gap-2 text-sm">
            <input
              className="mt-1"
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我已核对以上点数、日期与积分账户
          </label>
          <FormError error={mutation.error} />
          <Button
            disabled={!accountId || !confirmed || mutation.pending}
            onClick={() =>
              void mutation.run(async () => {
                await api(`/api/statements/${statementId}/rewards`, "POST", {
                  loyaltyAccountId: accountId,
                  confirmed: true,
                });
              }, "积分已记录")
            }
          >
            记录积分
          </Button>
        </div>
      ) : (
        <Link className="mt-3 inline-block text-sm text-primary" href="/rewards">
          先添加积分账户并关联这张信用卡 →
        </Link>
      )}
    </section>
  );
}
