"use client";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { Account } from "@/components/ledger/types";
import { statusLabels, type StatementList } from "./types";
export function StatementListView({
  statements,
  accounts,
  plaidEnabled = false,
}: {
  statements: StatementList;
  accounts: Account[];
  plaidEnabled?: boolean;
}) {
  return (
    <div className="space-y-6">
      {!statements.length ? (
        <div className="rounded-xl border border-dashed bg-card p-8 text-sm leading-7">
          账单收件箱还是空的。{plaidEnabled ? "上传账单或连接银行后" : "上传账单后"}，候选交易会显示在这里。
        </div>
      ) : (
        <div className="divide-y rounded-xl border bg-card">
          {statements.map((statement) => (
            <Link
              key={statement.id}
              href={`/statements/${statement.id}`}
              className="flex items-center justify-between gap-3 p-5 hover:bg-muted/40"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{statement.title ?? statement.originalFilename}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {statement.source === "plaid"
                    ? "Plaid 同步 · 多账户"
                    : (accounts.find((account) => account.id === statement.accountId)?.name ??
                      "待选择账户")}{" "}
                  · {statement.syncDate ?? statement.periodEnd ?? "周期待核对"}
                  {statement.accountLast4 ? ` · 尾号 ${statement.accountLast4}` : ""}
                </p>
              </div>
              <span className="flex shrink-0 items-center gap-2">
                {statement.source === "plaid" ? <Badge variant="secondary">Plaid 同步</Badge> : null}
                <Badge variant="outline">{statusLabels[statement.status]}</Badge>
                <ArrowUpRight size={16} />
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
