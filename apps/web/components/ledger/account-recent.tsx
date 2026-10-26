"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { InlineMoney } from "@/components/money-amount";
import { entryLabels } from "@/lib/ledger/constants";
import { money } from "@/lib/money";
import type { EntryList } from "./types";

export function RecentEntryRows({ entries }: { entries: EntryList["entries"] }) {
  return (
    <ul className="divide-y" aria-label="最近流水列表">
      {entries.map((entry) => (
        <li key={entry.id} className="min-w-0">
          <Link
            href={`/activity?entryId=${entry.id}`}
            className="block min-w-0 space-y-1 rounded py-3 text-sm hover:bg-muted/50"
          >
            <span
              className="block truncate text-primary"
              title={
                entry.transfer
                  ? `${entry.transfer.from.accountName} → ${entry.transfer.to.accountName}`
                  : (entry.description ?? entry.merchant ?? undefined)
              }
            >
              {entry.transfer
                ? `${entry.transfer.from.accountName} → ${entry.transfer.to.accountName}`
                : entry.merchant || entry.description || entryLabels[entry.entryType]}
            </span>
            <span className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>
                {entry.effectiveDate}
                {entry.status === "draft" ? " · 草稿" : ""}
              </span>
              <span className="flex flex-wrap gap-x-2">
                {Object.entries(
                  entry.transfer ? { [entry.transfer.currency]: entry.transfer.amount } : entry.amounts,
                ).map(([currency, amount]) => (
                  <InlineMoney
                    key={currency}
                    currency={currency}
                    value={entry.entryType === "refund" ? money(amount).negated().toFixed(4) : amount}
                  />
                ))}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

// Mounted only while the account sheet is open, keyed by account id by its parent.
export function AccountRecent({ accountId }: { accountId: string }) {
  const [data, setData] = useState<EntryList | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/transactions?accountId=${accountId}&limit=10`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("recent_entries_unavailable");
        const result: EntryList = await response.json();
        if (!controller.signal.aborted) setData(result);
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
    }
    void load();
    return () => controller.abort();
  }, [accountId]);
  return (
    <section aria-label="最近流水" className="min-w-0 space-y-3 border-t pt-4">
      <h3 className="text-sm font-medium">最近流水</h3>
      <div className="h-72 min-w-0 overflow-y-auto" aria-busy={!data && !error}>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            暂时无法加载，请重新打开账户或查看全部流水。
          </p>
        ) : !data ? (
          <p role="status" className="text-sm text-muted-foreground">
            正在加载流水…
          </p>
        ) : data.entries.length ? (
          <RecentEntryRows entries={data.entries} />
        ) : (
          <p className="text-sm text-muted-foreground">这个账户尚无流水。</p>
        )}
      </div>
      <Link className="block text-sm text-primary" href={`/activity?accountId=${accountId}`}>
        查看全部流水 →
      </Link>
    </section>
  );
}
