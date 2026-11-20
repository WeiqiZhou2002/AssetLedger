import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import {
  accounts,
  cardBenefitProfiles,
  cardBenefitMarks,
  institutions,
  journalEntries,
  postings,
} from "@/db/schema";
import type { AppDb } from "@/db/types";
import { money, sumMoney } from "@/lib/money";
import { benefitFamilies, isMerchantOfferRefund } from "./config";
import { normalizedCreditName } from "./credit-name";
import { catalog as defaultCatalog, engineProduct, type Catalog } from "./catalog";
import { benefitMatchNames, matchProduct, rankProducts } from "./catalog/match-product";
import { effectiveBenefitProduct, linkedBenefitNames } from "./effective-product";
import { applyBenefitMarks } from "./marks";
import { benefitProgress } from "./progress";

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
export async function benefitOverview(
  db: AppDb,
  ownerId: string,
  asOf: string,
  year = asOf.slice(0, 4),
  catalog: Catalog = defaultCatalog,
) {
  const [rows, accountRows, profiles, linkedNames, starts, marks] = await Promise.all([
    benefitRecords(db, ownerId),
    db
      .select({
        accountId: accounts.id,
        name: accounts.name,
        currency: accounts.currency,
        institution: institutions.name,
        last4: accounts.last4,
        isActive: accounts.isActive,
        openedOn: accounts.openedOn,
        statementDay: accounts.statementDay,
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
    db
      .select({
        accountId: cardBenefitProfiles.accountId,
        catalogProductId: cardBenefitProfiles.catalogProductId,
      })
      .from(cardBenefitProfiles)
      .where(eq(cardBenefitProfiles.ownerId, ownerId)),
    linkedBenefitNames(db, ownerId),
    db
      .select({
        accountId: postings.accountId,
        start: sql<string>`min(coalesce(${journalEntries.postedDate}, ${journalEntries.eventDate}))::text`,
      })
      .from(postings)
      .innerJoin(
        journalEntries,
        and(eq(journalEntries.id, postings.journalEntryId), eq(journalEntries.ownerId, ownerId)),
      )
      .where(
        and(
          eq(postings.ownerId, ownerId),
          eq(journalEntries.status, "confirmed"),
          ne(journalEntries.entryType, "opening_balance"),
        ),
      )
      .groupBy(postings.accountId),
    db.select().from(cardBenefitMarks).where(eq(cardBenefitMarks.ownerId, ownerId)),
  ]);
  // Last 12 months is (same calendar day last year, asOf]; clamp leap-day to February's end.
  const previousYear = Number(asOf.slice(0, 4)) - 1;
  const priorDay = asOf.slice(5) === "02-29" ? "02-28" : asOf.slice(5);
  const since = `${previousYear}-${priorDay}`;
  const cards = accountRows
    .filter((card) => card.isActive || rows.some((row) => row.accountId === card.accountId))
    .map(({ accountId, name, currency, institution, last4, openedOn, statementDay }) => ({
      accountId,
      name,
      currency,
      institution,
      last4,
      openedOn,
      statementDay,
    }));
  const windows = (entry: (typeof rows)[number]) => {
    const date = entry.date ?? entry.eventDate;
    return { annual: date.startsWith(`${year}-`) && date <= asOf, rolling: date > since && date <= asOf };
  };
  const sum = (entries: typeof rows) =>
    entries.reduce((total, row) => total.plus(row.amount), money("0")).toFixed(4);
  const namesByAccount = new Map<string, typeof linkedNames>();
  for (const row of linkedNames) {
    if (!row.accountId) continue;
    const names = namesByAccount.get(row.accountId) ?? [];
    names.push(row);
    namesByAccount.set(row.accountId, names);
  }
  const startByAccount = new Map(starts.map((row) => [row.accountId, row.start]));
  return {
    asOf,
    year,
    since,
    catalogVersion: catalog.catalogVersion,
    products: catalog.cards
      .map(({ id, name, issuer, audience, availability }) => ({ id, name, issuer, audience, availability }))
      .sort((a, b) => a.issuer.localeCompare(b.issuer) || a.name.localeCompare(b.name)),
    years: [
      ...new Set([asOf.slice(0, 4), year, ...rows.map((row) => (row.date ?? row.eventDate).slice(0, 4))]),
    ]
      .sort()
      .reverse(),
    cards: cards.map((card) => {
      const entries = rows.filter((row) => row.accountId === card.accountId);
      const annual = entries.filter((row) => windows(row).annual);
      const profile = profiles.find((profile) => profile.accountId === card.accountId);
      const matchInput = {
        institution: card.institution,
        names: benefitMatchNames(card.name, namesByAccount.get(card.accountId) ?? []),
      };
      const effective = effectiveBenefitProduct({ ...matchInput, profile }, catalog);
      const { product } = effective;
      const autoMatch = matchProduct(matchInput, catalog);
      const engineProgress = product
        ? benefitProgress({
            catalog: engineProduct(product),
            account: {
              currency: card.currency,
              product_id: product.id,
              anniversary: card.openedOn,
              statement_close_day: card.statementDay,
              tracking_start: startByAccount.get(card.accountId) ?? asOf,
            },
            overrides: [],
            entries: entries
              .filter((row) => (row.date ?? row.eventDate) <= asOf)
              .map((row) => ({
                id: row.id,
                date: row.date ?? row.eventDate,
                amount: row.amount,
                currency: row.currency,
                description: row.description,
                merchant: row.merchant,
                family: row.family,
              })),
            as_of: asOf,
            view_year: Number(year),
          })
        : null;
      const progress =
        engineProgress && product
          ? {
              ...engineProgress,
              instances: applyBenefitMarks(
                engineProgress.instances,
                marks.filter((mark) => mark.accountId === card.accountId),
                product.id,
                asOf,
              ),
            }
          : null;
      const unmatched = progress ? new Set(progress.unmatched.map((entry) => entry.entry)) : null;
      const otherEntries = unmatched ? entries.filter((entry) => unmatched.has(entry.id)) : entries;
      const trackedYears =
        progress?.instances.flatMap((instance) =>
          instance.status === "ok" && "year" in instance ? [instance.year] : [],
        ) ?? [];
      const catalogDetails =
        product && progress
          ? {
              productId: product.id,
              productName: product.name,
              issuer: product.issuer,
              currency: product.currency,
              coverage: product.coverage,
              catalogVersion: catalog.catalogVersion,
              sources: product.sources,
              instances: progress.instances,
              informational: progress.informational,
              annual: {
                used: sumMoney(trackedYears.map((year) => year.used)).toFixed(4),
                cap: sumMoney(trackedYears.map((year) => year.cap)).toFixed(4),
              },
            }
          : effective.stale && profile?.catalogProductId
            ? { productId: profile.catalogProductId, stale: true as const }
            : null;
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
      for (const row of otherEntries.filter((row) => windows(row).annual)) {
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
        catalog: catalogDetails,
        asOf,
        productSource: effective.source,
        autoProductId: autoMatch?.productId ?? null,
        suggestedProductIds: rankProducts(matchInput, catalog),
        annual: sum(annual),
        rolling: sum(entries.filter((row) => windows(row).rolling)),
        byName: [...names.values()]
          .sort((a, b) => money(b.total).cmp(a.total) || a.name.localeCompare(b.name))
          .map((group) => ({
            ...group,
            entries: group.entries.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)),
          })),
        families: benefitFamilies.flatMap((family) => {
          const matching = otherEntries.filter(
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
