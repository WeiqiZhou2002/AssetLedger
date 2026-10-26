"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatAmount } from "@/lib/ledger/format";
import type { entryMatching } from "@/lib/bank-sync/matching";
import { api, FormError, SelectField, useLedgerMutation } from "./forms";

type Matching = Awaited<ReturnType<typeof entryMatching>>;
export function EntryMatching({
  entryId,
  matchId,
  onSaved,
}: {
  entryId: string;
  matchId: string | null;
  onSaved: () => void;
}) {
  const [data, setData] = useState<Matching | null>(null);
  const mutation = useLedgerMutation();
  return (
    <section className="space-y-3 rounded-xl border bg-muted/30 p-4">
      <h3 className="text-sm font-medium">转账匹配</h3>
      <p className="text-xs leading-6 text-muted-foreground">
        两侧保留各自日期。确认匹配会将原收支作废替换为清算分录，不再计入支出或收入。
      </p>
      {matchId ? (
        <Button
          variant="outline"
          disabled={mutation.pending}
          onClick={() =>
            mutation.run(async () => {
              await api(`/api/transactions/${entryId}/matching`, "POST", { action: "unmatch" });
              onSaved();
            }, "已取消匹配，两侧按资金方向恢复收支；借款账户保留待处理")
          }
        >
          取消匹配
        </Button>
      ) : (
        <Button
          variant="outline"
          disabled={mutation.pending}
          onClick={() =>
            mutation.run(async () => setData(await api<Matching>(`/api/transactions/${entryId}/matching`)))
          }
        >
          匹配为转账 / 查看诊断
        </Button>
      )}
      {data ? (
        <>
          {data.eligible && data.accounts.length ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                const accountId = new FormData(event.currentTarget).get("accountId");
                void mutation.run(async () => {
                  await api(`/api/transactions/${entryId}/matching`, "POST", { action: "assign", accountId });
                  onSaved();
                }, "已创建对方分录并匹配为转账");
              }}
            >
              <SelectField name="accountId" label="指定对方账户" required defaultValue="">
                <option value="">选择对方账户</option>
                {data.accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </SelectField>
              <p className="text-xs text-muted-foreground">
                将按本笔金额和日期创建对方分录。对方流水已存在时，请使用下方候选匹配。
              </p>
              <Button type="submit" disabled={mutation.pending}>
                指定对方账户并匹配
              </Button>
            </form>
          ) : null}
          <ul className="space-y-2 text-xs leading-6 text-muted-foreground">
            {data.diagnostics.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
          {data.eligible && data.candidates.length ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                const counterpartEntryId = new FormData(event.currentTarget).get("counterpart");
                void mutation.run(async () => {
                  await api(`/api/transactions/${entryId}/matching`, "POST", {
                    action: "match",
                    counterpartEntryId,
                  });
                  onSaved();
                }, "两侧已匹配为转账");
              }}
            >
              <SelectField
                name="counterpart"
                label="反向等额候选（至多七天，可选手工 / PDF / 已编辑流水）"
                required
                defaultValue=""
              >
                <option value="">请核对后选择对方流水</option>
                {data.candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.date} · {candidate.accountName} ·{" "}
                    {formatAmount(candidate.amount, candidate.currency)} · {candidate.description}
                  </option>
                ))}
              </SelectField>
              <Button type="submit" disabled={mutation.pending}>
                确认匹配两侧
              </Button>
            </form>
          ) : data.eligible ? (
            <p className="text-sm text-muted-foreground">暂无七天内的反向等额候选。</p>
          ) : null}
        </>
      ) : null}
      <FormError error={mutation.error} />
    </section>
  );
}
