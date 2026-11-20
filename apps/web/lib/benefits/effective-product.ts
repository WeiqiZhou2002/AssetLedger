import { and, eq } from "drizzle-orm";
import { bankConnectionAccounts } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { catalog as defaultCatalog, type Catalog, type CatalogCard } from "./catalog";
import { matchProduct } from "./catalog/match-product";

export async function linkedBenefitNames(db: AppDb, ownerId: string, accountId?: string) {
  return db
    .select({
      accountId: bankConnectionAccounts.accountId,
      name: bankConnectionAccounts.name,
      officialName: bankConnectionAccounts.officialName,
    })
    .from(bankConnectionAccounts)
    .where(
      and(
        eq(bankConnectionAccounts.ownerId, ownerId),
        accountId ? eq(bankConnectionAccounts.accountId, accountId) : undefined,
      ),
    );
}
export function effectiveBenefitProduct(
  input: {
    profile?: { catalogProductId: string | null };
    institution: string | null;
    names: string[];
  },
  catalog: Catalog = defaultCatalog,
): {
  product: CatalogCard | null;
  source: "auto" | "manual" | "none" | null;
  stale: boolean;
} {
  if (input.profile) {
    if (input.profile.catalogProductId === null) return { product: null, source: "none", stale: false };
    const product = catalog.cards.find((card) => card.id === input.profile!.catalogProductId) ?? null;
    return { product, source: "manual", stale: product === null };
  }
  const match = matchProduct(input, catalog);
  return {
    product: match ? catalog.cards.find((card) => card.id === match.productId)! : null,
    source: match ? "auto" : null,
    stale: false,
  };
}
