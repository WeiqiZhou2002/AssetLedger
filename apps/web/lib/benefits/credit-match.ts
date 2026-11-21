import { money } from "@/lib/money";
import { effective, matchEntry } from "./progress/match";
import { keywordHits } from "./progress/normalize";
import type { BenefitEntry, Credit, ProgressInput } from "./progress/types";

const stopTokens = new Set(
  `CREDIT CREDITS CR STATEMENT BENEFIT BENEFITS ADJUSTMENT ADJ REIMBURSEMENT REIMB REFUND
   AMEX AMERICAN EXPRESS PLATINUM BUSINESS GOLD GREEN CARD CARDMEMBER THE FOR OF AND BY FROM ON YOUR
   US USA ANNUAL MONTHLY QUARTERLY CHASE SAPPHIRE RESERVE CAPITAL CITI BILT VENTURE`.split(/\s+/),
);
export function creditTokens(text: string, split = false): Set<string> {
  const normalized = text.replace(/[®™℠©]/gu, "").normalize("NFKC");
  const expanded = split
    ? `${normalized} ${normalized
        .replace(/(\p{Ll})(\p{Lu}\p{Ll})/gu, "$1 $2")
        .toUpperCase()
        .replace(/([A-Z]{3,})(CREDITS?|BENEFITS?)\b/g, "$1 $2")}`
    : normalized;
  return new Set(
    expanded
      .toUpperCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 2 && !/\p{N}/u.test(token) && !stopTokens.has(token)),
  );
}
type Score = { coverage: number; matchedChars: number; hits: Set<string> };
type Candidate = Score & { credit: Credit; amount: string | null };
const compareScore = (a: Score, b: Score) => b.coverage - a.coverage || b.matchedChars - a.matchedChars;
function score(credit: Credit, tokens: Set<string>): Score {
  return (
    [credit.name, ...credit.match.keywords]
      .map((text) => [...creditTokens(text)])
      .filter((signature) => signature.length > 0)
      .flatMap((signature) => {
        const hits = new Set(signature.filter((token) => tokens.has(token)));
        // Partial signatures need a distinctive leading token; short names need all tokens.
        if (hits.size < signature.length && (!hits.has(signature[0]) || signature[0].length < 4)) return [];
        return [
          {
            coverage: hits.size / signature.length,
            matchedChars: [...hits].reduce((total, token) => total + token.length, 0),
            hits,
          },
        ];
      })
      .sort(compareScore)[0] ?? { coverage: 0, matchedChars: 0, hits: new Set<string>() }
  );
}
function candidates(entry: BenefitEntry, input: ProgressInput): Candidate[] {
  const text = `${entry.description ?? ""} ${entry.merchant ?? ""}`;
  const tokens = creditTokens(text, true);
  return input.catalog.credits.flatMap((credit) => {
    if (credit.delivery && credit.delivery !== "statement_credit") return [];
    if (credit.match.exclude?.some((keyword) => keywordHits(text, keyword))) return [];
    const version = [...credit.versions]
      .sort((a, b) => (b.effective_from ?? "").localeCompare(a.effective_from ?? ""))
      .find((version) => effective(version, entry.date));
    if (!version) return [];
    const result = score(credit, tokens);
    return result.coverage >= 0.5 ? [{ ...result, credit, amount: version.amount }] : [];
  });
}
export type EntryCreditMatch = {
  automaticCreditId: string | null;
  source: "keyword" | "fuzzy" | "amount" | null;
  ownerAssigned: boolean;
  ownerCreditId: string | null;
};
function automaticMatch(entry: BenefitEntry, input: ProgressInput) {
  const match = matchEntry(entry, input);
  if (!match.credit && match.reason !== "no_match" && match.reason !== "ambiguous")
    return { creditId: null, source: null };
  const fuzzy = candidates(entry, input).sort(compareScore);
  let selected = match.credit ? fuzzy.find((candidate) => candidate.credit.id === match.credit) : fuzzy[0];
  let creditId = match.credit;
  let source: EntryCreditMatch["source"] = creditId ? "keyword" : null;
  if (!creditId && selected) {
    const tied = fuzzy.filter((candidate) => compareScore(selected!, candidate) === 0);
    if (tied.length > 1) {
      const sufficient = tied.filter(
        (candidate) => candidate.amount !== null && money(candidate.amount).gte(entry.amount),
      );
      if (sufficient.length !== 1) return { creditId: null, source: null };
      selected = sufficient[0];
      source = "amount";
    } else source = "fuzzy";
    creditId = selected.credit.id;
  }
  if (
    selected?.amount !== null &&
    selected?.amount !== undefined &&
    money(entry.amount).gt(selected.amount)
  ) {
    const sufficient = fuzzy
      .filter(
        (candidate) =>
          candidate.credit.id !== selected.credit.id &&
          [...candidate.hits].some((token) => selected.hits.has(token)) &&
          candidate.amount !== null &&
          money(candidate.amount).gte(entry.amount),
      )
      .sort((a, b) => compareScore(a, b) || money(a.amount!).cmp(b.amount!));
    const best = sufficient[0];
    // Identical scores and caps cannot establish a unique sibling.
    if (
      best &&
      !(
        sufficient[1] &&
        compareScore(best, sufficient[1]) === 0 &&
        money(best.amount!).eq(sufficient[1].amount!)
      )
    ) {
      creditId = best.credit.id;
      source = "amount";
    }
  }
  return { creditId, source };
}
// Only AL-created fuzzy/amount picks are forced into the engine. An unchanged engine
// match retains its own posting-lag semantics; owner overrides always take precedence.
export function matchBenefitCredits(
  input: ProgressInput,
  assignments: ReadonlyMap<string, string | null> = new Map(),
): { entries: BenefitEntry[]; matches: Record<string, EntryCreditMatch> } {
  const matches: Record<string, EntryCreditMatch> = {};
  const entries = input.entries.map((original) => {
    const entry = { ...original };
    delete entry.assigned_credit;
    const automatic = automaticMatch(entry, input);
    const ownerAssigned = assignments.has(entry.id);
    const ownerCreditId = assignments.get(entry.id) ?? null;
    matches[entry.id] = {
      automaticCreditId: automatic.creditId,
      source: automatic.source,
      ownerAssigned,
      ownerCreditId,
    };
    if (ownerAssigned) return { ...entry, assigned_credit: ownerCreditId };
    return automatic.creditId && automatic.source !== "keyword"
      ? { ...entry, assigned_credit: automatic.creditId }
      : entry;
  });
  return { entries, matches };
}
