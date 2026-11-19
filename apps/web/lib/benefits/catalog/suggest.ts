import { keywordHits } from "../progress/normalize";
import type { Catalog } from ".";
export function suggestProducts(
  { institution, accountName }: { institution: string | null; accountName: string },
  catalog: Catalog,
): string[] {
  const text = `${institution ?? ""} ${accountName}`;
  const aliases = catalog.cards.filter((card) => card.aliases.some((alias) => keywordHits(text, alias)));
  const issuers = catalog.cards.filter((card) => keywordHits(institution ?? "", card.issuer));
  return [...new Set([...aliases, ...issuers].map((card) => card.id))];
}
