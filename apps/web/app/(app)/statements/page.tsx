import { PageHeading } from "@/components/page-heading";
import { StatementListView } from "@/components/imports/statement-list";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/db/client";
import { listAccounts } from "@/lib/ledger/accounts";
import { listStatements } from "@/lib/imports/service";
import { loadPlaidConfig } from "@/lib/bank-sync/config";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { StatementUpload } from "@/components/imports/upload";
import { ConnectionsView } from "@/components/bank-sync/connections-view";
import { listConnections } from "@/lib/bank-sync/connections";
import { jsonSafe } from "@/lib/serialization";
import { pendingWorkbench } from "@/lib/bank-sync/pending";
import { listCategories } from "@/lib/ledger/categories";
import { PendingView, TransferSuggestions } from "@/components/bank-sync/pending-view";
import { transferSuggestions } from "@/lib/bank-sync/transfer-suggestions";
import { listResetExports } from "@/lib/bank-sync/reset-files";
import { ConnectionTransfer } from "@/components/bank-sync/connection-transfer";
export const metadata = { title: "导入与同步" };
export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  const db = getDb();
  const { config: env } = await loadPlaidConfig(db, user.id);
  const enabled = env.PLAID_ENABLED === "true";
  const sync = enabled && (await searchParams).tab !== "inbox";
  const [statements, accounts, connections, workbench, categories, recoveries, suggestions] =
    await Promise.all([
      sync ? Promise.resolve([]) : listStatements(db, user.id),
      listAccounts(db, user.id),
      sync ? listConnections(db, user.id, env) : Promise.resolve([]),
      sync ? pendingWorkbench(db, user.id, env.PLAID_ENV) : Promise.resolve(null),
      sync ? listCategories(db, user.id) : Promise.resolve([]),
      sync ? listResetExports(db, user.id) : Promise.resolve([]),
      sync ? Promise.resolve([]) : transferSuggestions(db, user.id),
    ]);
  return (
    <>
      <PageHeading
        eyebrow="STATEMENTS"
        title="导入与同步"
        description={
          enabled
            ? "银行同步自动入账；PDF / CSV 保留逐行审核，所有来源都有据可查。"
            : "保留证据，逐行核对，再让交易进入账本。"
        }
      />
      <div className={`mb-6 grid gap-3 ${enabled ? "grid-cols-2" : "grid-cols-1 sm:max-w-xs"}`}>
        {enabled ? (
          <Button asChild className="h-auto min-h-10 whitespace-normal">
            <Link href="/statements?tab=sync#connect-banks">连接银行（Plaid）</Link>
          </Button>
        ) : null}
        <StatementUpload accounts={accounts} maxMb={env.MAX_UPLOAD_MB} secondary={enabled} />
      </div>
      {enabled ? (
        <nav aria-label="导入方式" className="mb-6 flex gap-2 border-b pb-3">
          <Button asChild variant={sync ? "ghost" : "secondary"}>
            <Link href="/statements?tab=inbox" aria-current={!sync ? "page" : undefined}>
              收件箱
            </Link>
          </Button>
          <Button asChild variant={sync ? "secondary" : "ghost"}>
            <Link href="/statements?tab=sync" aria-current={sync ? "page" : undefined}>
              自动同步
            </Link>
          </Button>
        </nav>
      ) : null}
      {sync ? (
        <div className="space-y-6">
          {workbench ? (
            <PendingView data={jsonSafe(workbench)} accounts={accounts} categories={categories} />
          ) : null}
          <ConnectionsView
            connections={jsonSafe(connections)}
            accounts={accounts}
            environment={env.PLAID_ENV}
            interval={env.PLAID_SYNC_INTERVAL_HOURS}
            timezone={user.timezone}
          />
          {recoveries.length ? (
            <section className="rounded-xl border bg-card p-5 text-sm leading-7">
              <h2 className="font-medium">重置恢复导出</h2>
              <p className="text-xs text-muted-foreground">
                包含重置前的流水与关联资料，仅您可下载；到期后自动删除文件。
              </p>
              <ul className="mt-3 space-y-2">
                {recoveries.map((row) => (
                  <li key={row.id}>
                    <a className="text-primary underline" href={row.downloadUrl}>
                      {row.createdAt.toISOString().slice(0, 10)} · {row.counts.entries_deleted} 笔流水 · 下载
                      JSON
                    </a>
                    <span className="ml-2 text-xs">保留至 {row.expiresAt.toISOString().slice(0, 10)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <ConnectionTransfer totpEnabled={Boolean(user.totpEnabledAt)} />
        </div>
      ) : (
        <div className="space-y-6">
          {suggestions.length ? (
            <div id="pending" className="min-w-0 rounded-xl border bg-card p-5">
              <TransferSuggestions items={suggestions} />
            </div>
          ) : null}
          <StatementListView statements={statements} accounts={accounts} plaidEnabled={enabled} />
        </div>
      )}
    </>
  );
}
