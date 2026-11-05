"use client";
import { useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { formatAmount } from "@/lib/ledger/format";
import { entryLabels } from "@/lib/ledger/constants";
import type { JsonSafe } from "@/lib/serialization";
import type { pendingWorkbench } from "@/lib/bank-sync/pending";

type Entries = JsonSafe<Awaited<ReturnType<typeof pendingWorkbench>>>["recent"];
export function RecentAutoPosts({ entries }: { entries: Entries }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="min-w-0 rounded-xl border bg-card p-4 sm:p-5">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="recent-auto-posts"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 rounded-md text-left font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ChevronDown
          aria-hidden
          className={`size-4 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
        最近自动入账{entries.length ? ` · ${entries.length} 笔` : ""}
      </button>
      <div id="recent-auto-posts" hidden={!expanded} className="mt-4 border-t pt-4">
        {entries.length ? (
          <ul className="divide-y">
            {entries.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-start justify-between gap-2 py-3 text-sm">
                <div className="min-w-0">
                  <Link
                    className="break-words text-primary underline-offset-4 hover:underline"
                    href={`/activity?entryId=${entry.id}`}
                  >
                    {entry.transfer
                      ? `${entry.transfer.from.accountName} → ${entry.transfer.to.accountName}`
                      : entry.merchant || entryLabels[entry.type]}
                  </Link>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {entry.date ?? entry.eventDate} · {entry.accountName} · {entryLabels[entry.type]}
                    {entry.transferMatchId ? " · 已匹配" : ""}
                  </p>
                </div>
                <span className="tabular-nums">
                  {formatAmount(entry.transfer?.amount ?? entry.amount, entry.currency)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">同步完成后，已入账交易会显示在这里。</p>
        )}
      </div>
    </section>
  );
}
