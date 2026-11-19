import { z } from "zod";
import { amountSchema } from "@/lib/money";
import type { Product } from "../progress/types";
import feed from "./credits.json";
const date = z.iso.date();
const conditions = z.object({
  minimum_spend: z.object({ amount: amountSchema, period: z.string() }).optional(),
  minimum_nights: z.number().int().positive().optional(),
  consecutive_months: z.number().int().positive().optional(),
});
const version = z.object({
  effective_from: date.nullable(),
  effective_to: date.nullable(),
  status: z.enum(["verified", "to_verify"]),
  amount: amountSchema.nullable(),
  // API v1 is additive. Unknown cadence/basis remains displayable, but cannot produce periods.
  period: z.string(),
  reset_basis: z.string(),
  period_years: z.number().int().positive().optional(),
  max_posting_lag_days: z.number().int().nonnegative().nullable(),
  cap_excludes_tax: z.boolean().optional(),
  conditions: conditions.optional(),
  last_verified: date.nullable(),
  tracking: z.object({ supported: z.boolean(), reasons: z.array(z.string()) }),
});
export const catalogSchema = z.object({
  api_version: z.literal(1),
  catalog_version: z.string(),
  data: z.object({
    contract: z.object({ name: z.literal("credit-progress"), format_version: z.literal(1) }),
    cards: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        issuer: z.string(),
        currency: z.string(),
        audience: z.string(),
        availability: z.string(),
        aliases: z.array(z.string()),
        coverage: z.string().nullable(),
        sources: z.array(z.object({ id: z.string(), url: z.url(), title: z.string(), accessed: date })),
        credits: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            category: z.string(),
            family: z.string().optional(),
            delivery: z.string(),
            enrollment: z.string(),
            match: z.object({ keywords: z.array(z.string()), exclude: z.array(z.string()).optional() }),
            versions: z.array(version),
          }),
        ),
      }),
    ),
  }),
});
export function parseCatalog(input: unknown) {
  const parsed = catalogSchema.parse(input);
  return { catalogVersion: parsed.catalog_version, cards: parsed.data.cards };
}
export type Catalog = ReturnType<typeof parseCatalog>;
export type CatalogCard = Catalog["cards"][number];
export const catalog = parseCatalog(feed);
export const { catalogVersion, cards } = catalog;
const byId = new Map(cards.map((card) => [card.id, card]));
export const productById = (id: string) => byId.get(id);
export function engineProduct(card: CatalogCard): Product {
  return {
    id: card.id,
    name: card.name,
    issuer: card.issuer,
    currency: card.currency,
    credits: card.credits.map((credit) => ({
      ...credit,
      versions: credit.versions.map((version) => ({ ...version })),
    })),
  };
}
