import { cashTypes, transferTypes } from "@/lib/ledger/constants";
import { isMerchantOfferRefund } from "@/lib/benefits/config";
import { money } from "@/lib/money";
import { daysBetween } from "@/lib/money/fx";
import type { Leg } from "./transfer-legs";
import { isCashAdvanceSpend, isCashDeposit, paymentKeywords, transferKeywords } from "./transfer-config";

export type SignalLeg = Leg & {
  aliases: string[];
  mask: string | null;
  primary: string | null;
};
const aliasFamilies = [
  ["AMEX", "AMERICAN EXPRESS"],
  ["CITI", "CITIBANK"],
  ["BOA", "BANK OF AMERICA", "BKOFAMERICA"],
  ["CHASE"],
  ["CAPITAL ONE", "CAPITALONE", "CAP ONE"],
  ["BILT", "CARDLESS", "COLUMN"],
  ["US BANK", "USBANK", "U.S. BANK"],
  ["FIDELITY"],
  ["X MONEY", "X CORP", "X.COM"],
  ["DISCOVER"],
  ["WELLS FARGO"],
];
const generic = new Set(
  "bank banking checking savings card credit debit account acct visa mastercard amex money cash online mobile payment usd cny hkd plaid the brokerage broker wallet institution loan balance personal current joint platinum gold reserve rewards business".split(
    " ",
  ),
);
function normalizeHint(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}
function contains(text: string, phrase: string) {
  return Boolean(phrase) && ` ${text} `.includes(` ${phrase} `);
}
export function accountAliases({
  institutionName,
  plaidInstitutionName,
}: {
  institutionName?: string | null;
  plaidInstitutionName?: string | null;
}) {
  const names = [institutionName, plaidInstitutionName];
  const normalized = names.filter((name): name is string => Boolean(name)).map(normalizeHint);
  const aliases = new Set<string>();
  // Account nicknames/product words are not identity evidence (e.g. Plus / Double / Preferred).
  for (const name of normalized) {
    const tokens = name.split(" ");
    if (tokens.some((token) => token.length >= 3 && !generic.has(token) && !/^\d+$/.test(token))) {
      aliases.add(name);
    }
  }
  for (const family of aliasFamilies) {
    const variants = family.map(normalizeHint);
    if (normalized.some((name) => variants.some((alias) => contains(name, alias)))) {
      for (const alias of variants) aliases.add(alias);
    }
  }
  return [...aliases];
}
export function counterpartyHint(a: SignalLeg, b: SignalLeg) {
  const text = normalizeHint(a.description);
  return (
    b.aliases.some((alias) => contains(text, alias)) ||
    Boolean(
      b.mask &&
      (/^\d{4}$/.test(b.mask)
        ? contains(text, b.mask)
        : /^\d{5}$/.test(b.mask) && (text.includes(b.mask) || contains(text, b.mask.slice(-4)))),
    )
  );
}
export function dateDistance(a: Leg, b: Leg) {
  return Math.min(
    ...[a.date, a.eventDate].flatMap((date) =>
      [b.date, b.eventDate].map((other) => Math.abs(daysBetween(date, other))),
    ),
  );
}
export function pairType(
  a: Pick<Leg, "accountId" | "accountType" | "amount" | "currency">,
  b: Pick<Leg, "accountId" | "accountType" | "amount" | "currency">,
) {
  if (
    a.accountId === b.accountId ||
    a.currency !== b.currency ||
    money(a.amount).isZero() ||
    !money(a.amount).plus(money(b.amount)).isZero()
  )
    return null;
  const positive = money(a.amount).gt(0) ? a : b;
  const negative = positive === a ? b : a;
  if (positive.accountType === "liability_credit_card" && cashTypes.includes(negative.accountType))
    return "credit_card_payment" as const;
  if (
    (transferTypes.includes(a.accountType) && transferTypes.includes(b.accountType)) ||
    (negative.accountType === "liability_credit_card" && cashTypes.includes(positive.accountType))
  )
    return "transfer" as const;
  return null;
}
function signals(leg: SignalLeg) {
  const primary = ["TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"].includes(leg.primary ?? "");
  const cardCredit = leg.accountType === "liability_credit_card" && money(leg.amount).gt(0);
  const keyword = (cardCredit ? paymentKeywords : transferKeywords).some((pattern) =>
    pattern.test(leg.description),
  );
  const protectedCredit =
    cardCredit && !keyword && !["TRANSFER_IN", "LOAN_PAYMENTS"].includes(leg.primary ?? "");
  return {
    keyword,
    primary,
    protected: protectedCredit || isCashDeposit(leg) || isCashAdvanceSpend(leg),
  };
}
// Both-sided signals avoid turning unrelated equal-amount purchases/deposits into transfers.
// A specific account hint outranks generic keywords; edited candidates still participate in ranking.
export function signalStrength(a: SignalLeg, b: SignalLeg) {
  if (isCashAdvanceSpend(a) || isCashAdvanceSpend(b) || isMerchantOfferRefund(a) || isMerchantOfferRefund(b))
    return 0;
  const ab = counterpartyHint(a, b);
  const ba = counterpartyHint(b, a);
  if (ab || ba) return ab && ba ? 3 : 2;
  const sa = signals(a);
  const sb = signals(b);
  if (sa.protected || sb.protected) return 0;
  if (sa.keyword && sb.keyword) return 1;
  const cardFunded = [a, b].some(
    (leg) => leg.accountType === "liability_credit_card" && money(leg.amount).lt(0),
  );
  return (sa.keyword || sa.primary) && (sb.keyword || sb.primary) && (!cardFunded || sa.keyword || sb.keyword)
    ? 1
    : 0;
}
export function candidatesFor<T extends Leg>(leg: Leg, all: T[], days = 5): T[] {
  return all.filter(
    (other) => other.id !== leg.id && dateDistance(leg, other) <= days && pairType(leg, other),
  );
}
export function strongestCandidates<T extends SignalLeg>(leg: T, all: T[]) {
  const scored = candidatesFor(leg, all).map((other) => ({ other, score: signalStrength(leg, other) }));
  const best = Math.max(0, ...scored.map((item) => item.score));
  return scored.filter((item) => item.score > 0 && item.score === best).map((item) => item.other);
}

// Index once per pass; thousands of ordinary ledger entries should not cause all-pairs comparisons.
export function amountIndex<T extends Leg>(legs: T[]) {
  const key = (leg: Leg) => `${leg.currency}:${money(leg.amount).abs().toFixed(4)}`;
  const groups = new Map<string, T[]>();
  for (const leg of legs) {
    const group = groups.get(key(leg)) ?? [];
    group.push(leg);
    groups.set(key(leg), group);
  }
  return (leg: Leg) => groups.get(key(leg)) ?? [];
}
