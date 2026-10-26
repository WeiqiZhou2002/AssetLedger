import { loadMatchedTransfers, representativeEntry, transferPeerExists } from "./transfers";
import { and, or, count, desc, eq, gte, ilike, inArray, lte, ne, sql, type SQL } from "drizzle-orm";
import { accounts, categories, journalEntries, postings } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { money } from "@/lib/money";
import { requireAccount } from "./accounts";
import { filtersSchema, dateSchema, type EntryFilters } from "./schemas";
import { invariant } from "./errors";
export type DateBasis = "posted" | "event";
export function effectiveDate(basis: DateBasis) {
  return basis === "posted"
    ? sql<string>`coalesce(${journalEntries.postedDate}, ${journalEntries.eventDate})`
    : sql<string>`${journalEntries.eventDate}`;
}
export async function balancesAsOf(db: AppDb, ownerId: string, date: string, basis: DateBasis = "posted") {
  dateSchema.parse(date);
  const [rows, sums] = await Promise.all([
    db
      .select()
      .from(accounts)
      .where(eq(accounts.ownerId, ownerId))
      .orderBy(accounts.sortOrder, accounts.name),
    db
      .select({ accountId: postings.accountId, balance: sql<string>`sum(${postings.amount})::text` })
      .from(postings)
      .innerJoin(
        journalEntries,
        and(eq(journalEntries.id, postings.journalEntryId), eq(journalEntries.ownerId, ownerId)),
      )
      .where(
        and(
          eq(postings.ownerId, ownerId),
          eq(journalEntries.status, "confirmed"),
          lte(effectiveDate(basis), date),
        ),
      )
      .groupBy(postings.accountId),
  ]);
  const balances = new Map(sums.map((row) => [row.accountId, row.balance]));
  return rows.map((account) => ({ ...account, balance: balances.get(account.id) ?? "0.0000" }));
}
export async function accountBalance(
  db: AppDb,
  ownerId: string,
  accountId: string,
  date: string,
  basis: DateBasis = "posted",
) {
  await requireAccount(db, ownerId, accountId);
  const balances = await balancesAsOf(db, ownerId, date, basis);
  return balances.find((account) => account.id === accountId)!.balance;
}
export async function spendingSummary(
  db: AppDb,
  ownerId: string,
  options: { from: string; to: string; basis: DateBasis; groupBy: "day" | "week" | "month" | "category" },
) {
  dateSchema.parse(options.from);
  dateSchema.parse(options.to);
  invariant(options.from <= options.to, "日期范围无效");
  const date = effectiveDate(options.basis);
  const group: SQL<string> =
    options.groupBy === "category"
      ? sql`${postings.categoryId}::text`
      : options.groupBy === "month"
        ? sql`to_char(${date}, 'YYYY-MM')`
        : options.groupBy === "week"
          ? sql`to_char(date_trunc('week', ${date}), 'YYYY-MM-DD')`
          : sql`${date}::text`;
  return db
    .select({ group, currency: postings.currency, amount: sql<string>`sum(${postings.amount})::text` })
    .from(postings)
    .innerJoin(
      journalEntries,
      and(eq(journalEntries.id, postings.journalEntryId), eq(journalEntries.ownerId, ownerId)),
    )
    .innerJoin(accounts, and(eq(accounts.id, postings.accountId), eq(accounts.ownerId, ownerId)))
    .where(
      and(
        eq(postings.ownerId, ownerId),
        eq(journalEntries.status, "confirmed"),
        eq(accounts.type, "expense"),
        gte(date, options.from),
        lte(date, options.to),
      ),
    )
    .groupBy(group, postings.currency)
    .orderBy(group, postings.currency);
}
function postingExists(ownerId: string, condition: SQL) {
  return sql`exists (select 1 from ${postings} inner join ${accounts} on ${accounts.id} = ${postings.accountId} and ${accounts.ownerId} = ${ownerId} where ${postings.ownerId} = ${ownerId} and ${postings.journalEntryId} = ${journalEntries.id} and ${condition})`;
}
export async function listEntries(db: AppDb, ownerId: string, input: EntryFilters = {}) {
  const filters = filtersSchema.parse(input);
  const date = effectiveDate(filters.basis);
  const conditions: (SQL | undefined)[] = [eq(journalEntries.ownerId, ownerId), representativeEntry(ownerId)];
  if (filters.from || filters.to)
    conditions.push(
      or(
        and(
          filters.from ? gte(date, filters.from) : undefined,
          filters.to ? lte(date, filters.to) : undefined,
        ),
        transferPeerExists(ownerId, (peer) => {
          const peerDate =
            filters.basis === "posted"
              ? sql`coalesce(${peer.postedDate}, ${peer.eventDate})`
              : sql`${peer.eventDate}`;
          return and(
            filters.from ? gte(peerDate, filters.from) : undefined,
            filters.to ? lte(peerDate, filters.to) : undefined,
          );
        }),
      ),
    );
  if (filters.type) conditions.push(eq(journalEntries.entryType, filters.type));
  if (filters.status) conditions.push(eq(journalEntries.status, filters.status));
  else conditions.push(ne(journalEntries.status, "voided"));
  if (filters.merchant) {
    const search = `%${filters.merchant.replace(/[\\%_]/g, "\\$&")}%`;
    conditions.push(
      or(
        ilike(journalEntries.merchant, search),
        ilike(journalEntries.description, search),
        transferPeerExists(ownerId, (peer) =>
          or(ilike(peer.merchant, search), ilike(peer.description, search)),
        ),
      ),
    );
  }
  if (filters.accountId)
    conditions.push(
      or(
        postingExists(ownerId, eq(postings.accountId, filters.accountId)),
        transferPeerExists(
          ownerId,
          (peer) =>
            sql`exists (select 1 from ${postings} where ${postings.ownerId} = ${ownerId} and ${postings.journalEntryId} = ${peer.id} and ${postings.accountId} = ${filters.accountId})`,
        ),
      ),
    );
  if (filters.categoryId)
    conditions.push(postingExists(ownerId, eq(postings.categoryId, filters.categoryId)));
  if (filters.view === "spending") conditions.push(postingExists(ownerId, eq(accounts.type, "expense")));
  if (filters.view === "income") conditions.push(postingExists(ownerId, eq(accounts.type, "income")));
  if (filters.view === "cashflow")
    conditions.push(
      postingExists(
        ownerId,
        inArray(accounts.type, ["asset_cash", "asset_brokerage_cash", "liability_credit_card"]),
      ),
    );
  if (filters.currency) conditions.push(postingExists(ownerId, eq(postings.currency, filters.currency)));
  if (filters.minAmount || filters.maxAmount) {
    const min = filters.minAmount ? sql`sum(${postings.amount}) >= ${filters.minAmount}::numeric` : sql`true`;
    const max = filters.maxAmount ? sql`sum(${postings.amount}) <= ${filters.maxAmount}::numeric` : sql`true`;
    const currency = filters.currency ? eq(postings.currency, filters.currency) : sql`true`;
    conditions.push(
      sql`exists (select 1 from ${postings} where ${postings.ownerId} = ${ownerId} and ${postings.journalEntryId} = ${journalEntries.id} and ${postings.amount} > 0 and ${currency} group by ${postings.currency} having ${min} and ${max})`,
    );
  }
  const where = and(...conditions);
  const [rows, total] = await Promise.all([
    db
      .select({ entry: journalEntries, effectiveDate: date })
      .from(journalEntries)
      .where(where)
      .orderBy(desc(date), desc(journalEntries.createdAt), journalEntries.id)
      .limit(filters.limit)
      .offset(filters.offset),
    db.select({ count: count() }).from(journalEntries).where(where),
  ]);
  const ids = rows.map((row) => row.entry.id);
  const lines = ids.length
    ? await db
        .select({
          posting: postings,
          accountName: accounts.name,
          accountType: accounts.type,
          categoryName: categories.name,
        })
        .from(postings)
        .innerJoin(accounts, and(eq(accounts.id, postings.accountId), eq(accounts.ownerId, ownerId)))
        .leftJoin(categories, and(eq(categories.id, postings.categoryId), eq(categories.ownerId, ownerId)))
        .where(and(eq(postings.ownerId, ownerId), inArray(postings.journalEntryId, ids)))
    : [];
  const transfers = await loadMatchedTransfers(
    db,
    ownerId,
    rows.flatMap(({ entry }) => (entry.transferMatchId ? [entry.transferMatchId] : [])),
  );
  const entries = rows.map(({ entry, effectiveDate }) => {
    const entryLines = lines.filter((line) => line.posting.journalEntryId === entry.id);
    const amounts: Record<string, string> = {};
    for (const { posting } of entryLines) {
      if (money(posting.amount).gt(0)) {
        amounts[posting.currency] = money(amounts[posting.currency] ?? "0")
          .plus(posting.amount)
          .toFixed(4);
      }
    }
    return {
      ...entry,
      effectiveDate,
      transfer: entry.transferMatchId ? (transfers.get(entry.transferMatchId) ?? null) : null,
      amounts,
      postings: entryLines.map(({ posting, ...labels }) => ({ ...posting, ...labels })),
    };
  });
  return { entries, total: total[0].count, limit: filters.limit, offset: filters.offset };
}
export async function ledgerOverview(db: AppDb, ownerId: string, today: string, basis: DateBasis) {
  dateSchema.parse(today);
  const [balances, spending, recent, drafts, recorded] = await Promise.all([
    balancesAsOf(db, ownerId, today, basis),
    spendingSummary(db, ownerId, { from: `${today.slice(0, 7)}-01`, to: today, basis, groupBy: "month" }),
    listEntries(db, ownerId, { basis, limit: 5 }),
    db
      .select({ count: count() })
      .from(journalEntries)
      .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.status, "draft"))),
    db
      .select({ count: count() })
      .from(journalEntries)
      .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.status, "confirmed"))),
  ]);
  const cardBalances: Record<string, string> = {};
  for (const account of balances.filter((row) => row.type === "liability_credit_card")) {
    cardBalances[account.currency] = money(cardBalances[account.currency] ?? "0")
      .plus(account.balance)
      .toFixed(4);
  }
  return {
    balances,
    spending,
    recent: recent.entries,
    draftCount: drafts[0].count,
    confirmedCount: recorded[0].count,
    cardBalances,
  };
}
