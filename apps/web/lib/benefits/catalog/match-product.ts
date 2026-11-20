import type { Catalog } from ".";

type MatchInput = { institution: string | null; names: string[] };
const generic = new Set(
  "card credit the from for by of and visa mastercard signature infinite world legend rewards account".split(
    " ",
  ),
);
const issuerAliases: Record<string, string[]> = {
  "american express": ["american express", "amex"],
  chase: ["chase", "jpmorgan"],
  "capital one": ["capital one", "capitalone"],
  citi: ["citi", "citibank"],
  "bank of america": ["bank of america", "bofa"],
  "wells fargo": ["wells fargo"],
  "u s bank": ["u s bank", "us bank", "usbank"],
  barclays: ["barclays", "barclaycard"],
  bilt: ["bilt"],
  robinhood: ["robinhood"],
};
function tokens(value: string): string[] {
  // Strip marks before NFKC as well: NFKC expands ™ and ℠ into letters.
  return value
    .replace(/[®™℠©]/gu, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter((token) => token && !/^\p{N}+$/u.test(token));
}
function containsPhrase(haystack: string[], phrase: string[]) {
  return haystack.some((_, i) => phrase.every((token, j) => haystack[i + j] === token));
}
export function benefitMatchNames(
  ledgerName: string,
  linkedRows: readonly { name: string; officialName: string | null }[],
): string[] {
  return [
    ...new Set(
      [
        ...linkedRows.map((row) => row.officialName),
        ...linkedRows.map((row) => row.name),
        ledgerName,
      ].flatMap((name) => (name?.trim() ? [name.trim()] : [])),
    ),
  ];
}
function productScores(input: MatchInput, catalog: Catalog) {
  const issuers = [...new Set(catalog.cards.map((card) => card.issuer))].map((issuer) => {
    const normalized = tokens(issuer).join(" ");
    const phrases = Object.hasOwn(issuerAliases, normalized) ? issuerAliases[normalized] : [normalized];
    return { issuer, phrases: phrases.map(tokens) };
  });
  const institution = tokens(input.institution ?? ""),
    names = input.names.map(tokens);
  const detectedIn = (texts: string[][]) =>
    issuers.filter(({ phrases }) =>
      texts.some((text) => phrases.some((phrase) => containsPhrase(text, phrase))),
    );
  const fromInstitution = detectedIn([institution]);
  const detected = fromInstitution.length ? fromInstitution : detectedIn(names);
  const allowed = new Set(detected.map(({ issuer }) => issuer));
  return catalog.cards.flatMap((card) => {
    if (allowed.size && !allowed.has(card.issuer)) return [];
    const phrases = issuers.find(({ issuer }) => issuer === card.issuer)!.phrases;
    const dropped = new Set([...generic, ...phrases.flat()]);
    const set = (parts: string[]) => new Set(parts.filter((token) => !dropped.has(token)));
    const products = [card.name, ...card.aliases].map((name) => set(tokens(name)));
    const scores = names.map((name) => {
      const account = set(name);
      if (!account.size) return 0;
      return Math.max(
        0,
        ...products.map((product) => {
          if (!product.size) return 0;
          const common = [...product].filter((token) => account.has(token)).length;
          return (2 * common) / (product.size + account.size);
        }),
      );
    });
    return [{ productId: card.id, scores }];
  });
}
function ranked(scores: { productId: string; score: number }[]) {
  return scores
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.productId.localeCompare(b.productId));
}
export function rankProducts(input: MatchInput, catalog: Catalog, limit = 5): string[] {
  return ranked(
    productScores(input, catalog).map(({ productId, scores }) => ({
      productId,
      score: Math.max(0, ...scores),
    })),
  )
    .slice(0, limit)
    .map(({ productId }) => productId);
}
export function matchProduct(input: MatchInput, catalog: Catalog) {
  const products = productScores(input, catalog);
  for (let index = 0; index < input.names.length; index++) {
    const [best, runnerUp] = ranked(
      products.map(({ productId, scores }) => ({ productId, score: scores[index] })),
    );
    if (best && best.score >= 0.75 && (!runnerUp || best.score > runnerUp.score)) return best;
  }
  return null;
}
