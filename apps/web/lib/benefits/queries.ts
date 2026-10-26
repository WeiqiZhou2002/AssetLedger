import { and, desc, eq, isNull, ne, or } from "drizzle-orm";
import { accounts, institutions, journalEntries, postings } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { money } from "@/lib/money";
import { benefitFamilies, isMerchantOfferRefund } from "./config";
import { normalizedCreditName } from "./credit-name";

async function benefitRecords(db: AppDb, ownerId: string) {
  const rows = await db
    .select({
      id: journalEntries.id,
      accountId: accounts.id,
      accountName: accounts.name,
      currency: postings.currency,
      amount: postings.amount,
      family: journalEntries.benefitFamily,
      date: journalEntries.postedDate,
      eventDate: journalEntries.eventDate,
      description: journalEntries.description,
      merchant: journalEntries.merchant,
    })
    .from(journalEntries)
    .innerJoin(postings, and(eq(postings.journalEntryId, journalEntries.id), eq(postings.ownerId, ownerId)))
    .innerJoin(accounts, and(eq(accounts.id, postings.accountId), eq(accounts.ownerId, ownerId)))
    .where(
      and(
        eq(journalEntries.ownerId, ownerId),
        eq(journalEntries.status, "confirmed"),
        eq(journalEntries.benefitCredit, true),
        or(isNull(journalEntries.benefitFamily), ne(journalEntries.benefitFamily, "offer")),
        eq(journalEntries.entryType, "refund"),
        eq(accounts.type, "liability_credit_card"),
      ),
    )
    .orderBy(desc(journalEntries.postedDate), desc(journalEntries.eventDate), journalEntries.id);
  return rows.filter(
    (row) =>
      !isMerchantOfferRefund({
        accountType: "liability_credit_card",
        amount: row.amount,
        description: `${row.description ?? ""} ${row.merchant ?? ""}`,
      }),
  );
}
export async function benefitOverview(db: AppDb, ownerId: string, asOf: string, year = asOf.slice(0, 4)) {
  const [rows, accountRows] = await Promise.all([
    benefitRecords(db, ownerId),
    db
      .select({
        accountId: accounts.id,
        name: accounts.name,
        currency: accounts.currency,
        institution: institutions.name,
        last4: accounts.last4,
        isActive: accounts.isActive,
      })
      .from(accounts)
      .leftJoin(
        institutions,
        and(eq(institutions.id, accounts.institutionId), eq(institutions.ownerId, ownerId)),
      )
      .where(
        and(
          eq(accounts.ownerId, ownerId),
          eq(accounts.type, "liability_credit_card"),
          eq(accounts.isSystem, false),
        ),
      )
      .orderBy(accounts.name, accounts.id),
  ]);
  // Last 12 months is (same calendar day last year, asOf]; clamp leap-day to February's end.
  const previousYear = Number(asOf.slice(0, 4)) - 1;
  const priorDay = asOf.slice(5) === "02-29" ? "02-28" : asOf.slice(5);
  const since = `${previousYear}-${priorDay}`;
  const cards = accountRows
    .filter((card) => card.isActive || rows.some((row) => row.accountId === card.accountId))
    .map(({ accountId, name, currency, institution, last4 }) => ({
      accountId,
      name,
      currency,
      institution,
      last4,
    }));
  const windows = (entry: (typeof rows)[number]) => {
    const date = entry.date ?? entry.eventDate;
    return { annual: date.startsWith(`${year}-`) && date <= asOf, rolling: date > since && date <= asOf };
  };
  const sum = (entries: typeof rows) =>
    entries.reduce((total, row) => total.plus(row.amount), money("0")).toFixed(4);
  return {
    asOf,
    year,
    since,
    years: [
      ...new Set([asOf.slice(0, 4), year, ...rows.map((row) => (row.date ?? row.eventDate).slice(0, 4))]),
    ]
      .sort()
      .reverse(),
    cards: cards.map((card) => {
      const entries = rows.filter((row) => row.accountId === card.accountId);
      const annual = entries.filter((row) => windows(row).annual);
      const names = new Map<
        string,
        {
          name: string;
          count: number;
          total: string;
          lastDate: string;
          entries: { id: string; date: string; description: string; amount: string }[];
        }
      >();
      for (const row of annual) {
        const name = normalizedCreditName(row.description, row.merchant);
        const date = row.date ?? row.eventDate;
        const previous = names.get(name);
        names.set(name, {
          name,
          count: (previous?.count ?? 0) + 1,
          total: money(previous?.total ?? "0")
            .plus(row.amount)
            .toFixed(4),
          lastDate: previous && previous.lastDate > date ? previous.lastDate : date,
          entries: [
            ...(previous?.entries ?? []),
            {
              id: row.id,
              date,
              description: row.description || row.merchant || "权益报销",
              amount: row.amount,
            },
          ],
        });
      }
      return {
        ...card,
        annual: sum(annual),
        rolling: sum(entries.filter((row) => windows(row).rolling)),
        byName: [...names.values()]
          .sort((a, b) => money(b.total).cmp(a.total) || a.name.localeCompare(b.name))
          .map((group) => ({
            ...group,
            entries: group.entries.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)),
          })),
        families: benefitFamilies.flatMap((family) => {
          const matching = entries.filter(
            (row) => row.family === family && (windows(row).annual || windows(row).rolling),
          );
          return matching.length
            ? [
                {
                  family,
                  annual: sum(matching.filter((row) => windows(row).annual)),
                  rolling: sum(matching.filter((row) => windows(row).rolling)),
                  entries: matching.map((row) => ({
                    id: row.id,
                    date: row.date ?? row.eventDate,
                    description: row.description || row.merchant || "权益报销",
                    amount: row.amount,
                  })),
                },
              ]
            : [];
        }),
      };
    }),
  };
}
