import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import { accounts, categories, journalEntries, postings } from "@/db/schema";
import { effectiveDate, listEntries, type DateBasis } from "@/lib/ledger/queries";
import { money } from "@/lib/money";
import { shiftDate } from "@/lib/bank-sync/date-range";
export async function dashboardLedger(db: AppDb, ownerId: string, today: string, basis: DateBasis) {
  const monthFrom = `${today.slice(0, 7)}-01`;
  const previousEnd = shiftDate(monthFrom, -1);
  const previousFrom = `${previousEnd.slice(0, 7)}-01`;
  const previousTo = `${previousEnd.slice(0, 7)}-${String(Math.min(Number(today.slice(8)), Number(previousEnd.slice(8)))).padStart(2, "0")}`;
  const dailyFrom = shiftDate(today, -29);
  const date = effectiveDate(basis);
  const [lines, recent] = await Promise.all([
    db
      .select({
        date,
        amount: postings.amount,
        currency: postings.currency,
        type: accounts.type,
        category: categories.name,
      })
      .from(postings)
      .innerJoin(
        journalEntries,
        and(eq(journalEntries.id, postings.journalEntryId), eq(journalEntries.ownerId, ownerId)),
      )
      .innerJoin(accounts, and(eq(accounts.id, postings.accountId), eq(accounts.ownerId, ownerId)))
      .leftJoin(categories, and(eq(categories.id, postings.categoryId), eq(categories.ownerId, ownerId)))
      .where(
        and(
          eq(postings.ownerId, ownerId),
          eq(journalEntries.status, "confirmed"),
          inArray(accounts.type, ["expense", "income"]),
          gte(date, previousFrom < dailyFrom ? previousFrom : dailyFrom),
          lte(date, today),
        ),
      ),
    listEntries(db, ownerId, { to: today, status: "confirmed", basis, limit: 8 }),
  ]);
  const aggregate = (
    selected: typeof lines,
    group: (row: (typeof lines)[number]) => string,
    income = false,
  ) => {
    const sums = new Map<string, { group: string; currency: string; amount: string }>();
    for (const row of selected) {
      const key = `${row.currency}:${group(row)}`;
      const old = sums.get(key);
      sums.set(key, {
        group: group(row),
        currency: row.currency,
        amount: money(old?.amount ?? "0")
          .plus(money(row.amount).mul(income ? "-1" : "1"))
          .toFixed(4),
      });
    }
    return [...sums.values()];
  };
  const expense = lines.filter((row) => row.type === "expense");
  const thisMonth = expense.filter((row) => row.date >= monthFrom);
  const daily = aggregate(
    expense.filter((row) => row.date >= dailyFrom),
    (row) => row.date,
  );
  const currencies = [...new Set(daily.map((row) => row.currency))];
  const dailySeries = currencies.map((currency) => ({
    currency,
    rows: Array.from({ length: 30 }, (_, day) => {
      const date = shiftDate(dailyFrom, day);
      return {
        date,
        amount: daily.find((row) => row.currency === currency && row.group === date)?.amount ?? "0.0000",
      };
    }),
  }));
  const categoryTotals = aggregate(thisMonth, (row) => row.category ?? "未分类");
  const byCategory = [...new Set(categoryTotals.map((row) => row.currency))].flatMap((currency) => {
    const sorted = categoryTotals
      .filter((row) => row.currency === currency)
      .sort((a, b) => money(b.amount).comparedTo(money(a.amount)));
    return [
      ...sorted.slice(0, 5),
      ...(sorted.length > 5
        ? [
            {
              currency,
              group: "其他",
              amount: sorted
                .slice(5)
                .reduce((sum, row) => sum.plus(money(row.amount)), money("0"))
                .toFixed(4),
            },
          ]
        : []),
    ];
  });
  return {
    spending: aggregate(thisMonth, () => "month"),
    previousSpending: aggregate(
      expense.filter((row) => row.date >= previousFrom && row.date <= previousTo),
      () => "month",
    ),
    income: aggregate(
      lines.filter((row) => row.type === "income" && row.date >= monthFrom),
      () => "month",
      true,
    ),
    previousFrom,
    previousTo,
    dailySeries,
    byCategory,
    recent: recent.entries,
  };
}
