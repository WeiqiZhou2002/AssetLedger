"use client";
import Link from "next/link";
import { Landmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormError, api, useLedgerMutation } from "@/components/ledger/forms";
import type { AccountReminderSummary } from "@/lib/bank-sync/account-reminder-summaries";

export function AccountChangeCard({ summaries }: { summaries: AccountReminderSummary[] }) {
  const mutation = useLedgerMutation();
  if (!summaries.length) return null;
  return (
    <section
      aria-labelledby="bank-account-changes"
      className="min-w-0 rounded-xl border border-primary/30 bg-primary/5 p-4 sm:p-5"
    >
      <h2 id="bank-account-changes" className="flex items-center gap-2 font-medium">
        <Landmark aria-hidden className="size-4 shrink-0 text-primary" />
        银行账户有变化
      </h2>
      <ul className="mt-3 divide-y divide-primary/15">
        {summaries.map((summary) => {
          const { id, institutionName } = summary;
          const connectionUrl = `/statements?tab=sync&connection=${id}`;
          return (
            <li key={id} className="space-y-2 py-3 text-sm first:pt-0 last:pb-0">
              {summary.newAccountsAvailable ? (
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <p className="min-w-0 flex-1 basis-64 break-words">{institutionName} 有新账户可以添加</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button asChild size="sm">
                      <Link href={`${connectionUrl}&select=accounts#connection-${id}`}>添加账户</Link>
                    </Button>
                    <Button
                      variant="link"
                      size="sm"
                      disabled={mutation.pending}
                      aria-label={`${institutionName}：暂不添加`}
                      onClick={() =>
                        void mutation.run(async () => {
                          await api(`/api/plaid/connections/${id}/dismiss-new-accounts`, "POST");
                        })
                      }
                    >
                      暂不添加
                    </Button>
                  </div>
                </div>
              ) : null}
              {summary.unmappedNewAccounts > 0 ? (
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <p className="min-w-0 flex-1 basis-64 break-words">
                    {institutionName} 发现 {summary.unmappedNewAccounts} 个新账户，确认映射后开始同步
                  </p>
                  <Button asChild variant="link" size="sm">
                    <Link href={`${connectionUrl}#mapping-${id}`}>确认映射</Link>
                  </Button>
                </div>
              ) : null}
              {summary.unsharedMapped > 0 ? (
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <p className="min-w-0 flex-1 basis-64 break-words text-muted-foreground">
                    {institutionName} {summary.unsharedMapped} 个账户已停止共享，不再同步
                  </p>
                  <Button asChild variant="link" size="sm">
                    <Link href={`${connectionUrl}#connection-${id}`}>查看</Link>
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <FormError error={mutation.error} />
    </section>
  );
}
