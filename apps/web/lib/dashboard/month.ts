import { and, eq, gte, lte } from "drizzle-orm";
import { accounts, categories, journalEntries, postings } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { effectiveDate, type DateBasis } from "@/lib/ledger/queries";
import { dateSchema } from "@/lib/ledger/schemas";
import { listFxRates } from "@/lib/snapshots/fx";
import { decimal, isStale } from "@/lib/money/fx";
import { shiftDate } from "@/lib/bank-sync/date-range";
export function monthWindow(requested: unknown, today: string) {
  const parsed =
    typeof requested === "string" &&
    Number(requested.slice(0, 4)) >= 1900 &&
    Number(requested.slice(0, 4)) <= 9998
      ? dateSchema.safeParse(`${requested}-01`)
      : null;
  const from = parsed?.success ? parsed.data : `${today.slice(0, 7)}-01`;
  const next = shiftDate(from, 32).slice(0, 7);
  const previous = shiftDate(from, -1).slice(0, 7);
  const end = shiftDate(`${next}-01`, -1);
  return {
    month: from.slice(0, 7),
    from,
    to: from.slice(0, 7) === today.slice(0, 7) ? today : end,
    previous,
    next,
  };
}
export async function monthSummary(
  db: AppDb,
  ownerId: string,
  month: unknown,
  today: string,
  basis: DateBasis,
  baseCurrency: string,
  fxStaleDays: number,
) {
  const window = monthWindow(month, today);
  const date = effectiveDate(basis);
  const [lines, rates] = await Promise.all([
    db
      .select({
        id: journalEntries.id,
        date,
        type: accounts.type,
        amount: postings.amount,
        currency: postings.currency,
        category: categories.name,
        categoryId: categories.id,
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
          gte(date, window.from),
          lte(date, window.to),
        ),
      ),
    listFxRates(db, ownerId),
  ]);
  const aggregate = (type: "expense" | "income") => {
    const selected = lines.filter((line) => line.type === type);
    const missing = new Set<string>();
    const stale = new Set<string>();
    const sums = new Map<string, { category: string; categoryId: string | null; amount: string }>();
    const days = new Map<string, string>();
    let total = decimal("0");
    let included = 0;
    for (const line of selected) {
      const rate =
        line.currency === baseCurrency
          ? { rate: "1", observedOn: line.date }
          : rates.find(
              (rate) =>
                rate.baseCurrency === baseCurrency &&
                rate.quoteCurrency === line.currency &&
                rate.observedOn <= line.date,
            );
      if (!rate) {
        missing.add(line.currency);
        continue;
      }
      if (isStale(rate.observedOn, line.date, fxStaleDays)) stale.add(line.currency);
      const value = decimal(line.amount)
        .mul(type === "income" ? "-1" : "1")
        .div(rate.rate);
      included++;
      total = total.plus(value);
      const key = line.categoryId ?? "none";
      const old = sums.get(key);
      sums.set(key, {
        category: line.category ?? "未分类",
        categoryId: line.categoryId,
        amount: decimal(old?.amount ?? "0")
          .plus(value)
          .toFixed(10),
      });
      days.set(
        line.date,
        decimal(days.get(line.date) ?? "0")
          .plus(value)
          .toFixed(10),
      );
    }
    const count =
      Math.round((Date.parse(`${window.to}T00:00:00Z`) - Date.parse(`${window.from}T00:00:00Z`)) / 86400000) +
      1;
    return {
      total: selected.length && !included ? null : total.toFixed(10),
      count: new Set(selected.map((row) => row.id)).size,
      missingFx: [...missing],
      staleFx: [...stale],
      categories: [...sums.values()]
        .sort((a, b) => decimal(b.amount).comparedTo(a.amount))
        .map((row) => ({
          ...row,
          share: total.isZero() ? null : decimal(row.amount).div(total).mul("100").toFixed(1),
        })),
      daily: Array.from({ length: count }, (_, index) => {
        const date = shiftDate(window.from, index);
        return { date, amount: days.get(date) ?? "0" };
      }),
    };
  };
  return { ...window, basis, baseCurrency, spending: aggregate("expense"), income: aggregate("income") };
}
