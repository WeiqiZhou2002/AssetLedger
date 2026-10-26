import type { AppDb } from "@/db/types";
import { listEntries, type DateBasis } from "@/lib/ledger/queries";
import { money } from "@/lib/money";

export async function monthActivity(
  db: AppDb,
  ownerId: string,
  window: { from: string; to: string; basis: DateBasis },
  view: "spending" | "income",
) {
  const data = await listEntries(db, ownerId, {
    from: window.from,
    to: window.to,
    basis: window.basis,
    view,
    status: "confirmed",
    limit: 100,
  });
  return {
    total: data.total,
    entries: data.entries.map((entry) => {
      const lines = entry.postings.filter(
        (line) => line.accountType === (view === "income" ? "income" : "expense"),
      );
      const amounts: Record<string, string> = {};
      for (const line of lines)
        amounts[line.currency] = money(amounts[line.currency] ?? "0")
          .plus(money(line.amount).mul(view === "income" ? "-1" : "1"))
          .toFixed(4);
      return {
        id: entry.id,
        date: entry.effectiveDate,
        description: entry.description || entry.merchant,
        categories: [...new Set(lines.map((line) => line.categoryName ?? "未分类"))],
        amounts,
      };
    }),
  };
}
export type MonthActivity = Awaited<ReturnType<typeof monthActivity>>;
