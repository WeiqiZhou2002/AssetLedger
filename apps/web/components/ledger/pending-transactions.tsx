"use client";
import { useId, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatAmount } from "@/lib/ledger/format";
import { money } from "@/lib/money";
import type { PendingTransactions } from "@/lib/bank-sync/pending-transactions";

export function PendingTransactionsSection({ pending }: { pending: PendingTransactions }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  if (!pending.total) return null;
  const groups = new Map<string, PendingTransactions["rows"]>();
  for (const row of pending.rows) {
    const group = groups.get(row.accountId);
    if (group) group.push(row);
    else groups.set(row.accountId, [row]);
  }
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <section className="mb-5 rounded-xl border border-dashed bg-muted/30 text-muted-foreground">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full flex-wrap items-center gap-2 p-4 text-left text-sm"
      >
        <Chevron size={16} aria-hidden />
        <span>待入账 · {pending.total} 笔</span>
        <Badge variant="outline" className="text-muted-foreground">
          未计入收支
        </Badge>
      </button>
      <div id={contentId} hidden={!expanded} className="space-y-4 px-4 pb-4">
        <p className="text-xs leading-6">银行尚未入账，金额可能变化；入账后会出现在下方流水并从这里移除。</p>
        {[...groups].map(([accountId, rows]) => (
          <section key={accountId}>
            <h3 className="mb-2 text-xs font-medium">
              {rows[0].accountName} · {rows[0].institutionName}
            </h3>
            <ul className="divide-y divide-dashed">
              {rows.map((row) => {
                const amount = money(row.amount);
                const inflow = amount.gt(0);
                return (
                  <li key={row.id} className="flex items-start justify-between gap-3 py-3 text-sm">
                    <div className="min-w-0">
                      <p className="break-words">{row.merchant || row.description}</p>
                      <p className="mt-1 text-xs">{row.transactionDate}</p>
                    </div>
                    <div className="max-w-[45%] shrink-0 text-right">
                      <p className="font-mono text-xs break-all sm:text-sm">
                        {inflow ? "+" : ""}
                        {formatAmount(amount.abs().toFixed(4), row.currency)}
                      </p>
                      <p className="mt-1 text-xs">{inflow ? "流入" : "流出"}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {pending.total > pending.rows.length ? <p className="text-xs">仅显示最近 200 笔</p> : null}
      </div>
    </section>
  );
}
