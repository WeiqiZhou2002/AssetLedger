import { money } from "@/lib/money";
import { paymentKeywords } from "./payment-keywords";

export const benefitFamilies = [
  "travel",
  "dining",
  "rideshare",
  "airline",
  "hotel",
  "entertainment",
  "shopping",
  "travel-program",
  "fitness",
  "wireless",
  "offer",
  "generic",
] as const;
export type BenefitFamily = (typeof benefitFamilies)[number];
// The stored enum retains historical offers; they are ordinary refunds, not card benefits.
export const selectableBenefitFamilies = benefitFamilies.filter((family) => family !== "offer");
export const merchantOffer = /\boffers?\b/i;
export function isMerchantOfferRefund(input: { accountType: string; amount: string; description: string }) {
  return (
    input.accountType === "liability_credit_card" &&
    money(input.amount).gt(0) &&
    merchantOffer.test(input.description) &&
    !paymentKeywords.some((pattern) => pattern.test(input.description))
  );
}
type Family = { label: string; pattern: RegExp; categories: string[] };
// Order specific families before generic statement-credit wording. Never applied to debits or cash accounts.
export const benefitConfig: Record<BenefitFamily, Family> = {
  travel: {
    label: "旅行权益",
    pattern: /\b(?:travel(?:\s+center)?\s+credit|annual\s+travel)\b/i,
    categories: ["旅行"],
  },
  dining: {
    label: "餐饮权益",
    pattern: /\b(?:dining\s+credit|resy|(?:dashpass|doordash)\s+credit)\b/i,
    categories: ["餐饮"],
  },
  rideshare: {
    label: "出行权益",
    pattern: /\b(?:uber\s+(?:cash|credit)|lyft\s+credit)\b/i,
    categories: ["交通"],
  },
  airline: {
    label: "航空权益",
    pattern: /\bairline\s+(?:fee\s+|incidental\s+)?credit\b/i,
    categories: ["旅行"],
  },
  hotel: {
    label: "酒店权益",
    pattern: /\b(?:hotel\s+credit|fhr(?:\s+credit)?|the\s+hotel\s+collection\s+credit)\b/i,
    categories: ["旅行"],
  },
  entertainment: {
    label: "娱乐订阅",
    pattern: /\b(?:digital\s+entertainment|streaming\s+credit)\b/i,
    categories: ["娱乐", "订阅服务"],
  },
  shopping: { label: "购物权益", pattern: /\b(?:saks\s+credit|walmart\+?\s+credit)/i, categories: ["购物"] },
  "travel-program": {
    label: "出行通行计划",
    pattern: /\b(?:clear|global\s+entry|tsa\s+precheck)\b/i,
    categories: ["旅行"],
  },
  fitness: { label: "健身权益", pattern: /\bequinox\b/i, categories: [] },
  wireless: {
    label: "话费权益",
    pattern:
      /\b(?:wireless|cell(?:ular)?\s+phone|mobile\s+phone)\s+(?:(?:telephone|phone|service)\s+){0,2}credit\b/i,
    categories: ["水电网络"],
  },
  offer: {
    label: "商户优惠",
    pattern: /\b(?:amex\s+offers?|offer\s+credit|cashback\s+offer)\b/i,
    categories: [],
  },
  generic: {
    label: "其他权益报销",
    pattern: /\b(?:statement\s+credit|credit\s+adjustment|reimbursement|reimb)\b/i,
    categories: [],
  },
};
// Generic exclusions augment the shared offer/payment guards above specific-family detection.
const genericExclusions =
  /\b(?:offers?|payments?|returns?|returned|refunds?|reversal|reversed|dispute|chargeback|provisional|interest|fees?|redemption|redeem(?:ed)?|rewards?|cash[\s-]?back|points?|miles|balance[\s-]+transfer)\b/i;
const genericKeywords = /\b(?:credits?|benefits?)\b/i;
export function detectBenefit(input: {
  accountType: string;
  amount: string;
  description: string;
  primary?: string | null;
}): BenefitFamily | null {
  if (
    input.accountType !== "liability_credit_card" ||
    !money(input.amount).gt(0) ||
    merchantOffer.test(input.description) ||
    paymentKeywords.some((pattern) => pattern.test(input.description))
  )
    return null;
  const specific = selectableBenefitFamilies.find(
    (family) => family !== "generic" && benefitConfig[family].pattern.test(input.description),
  );
  if (specific) return specific;
  if (["LOAN_PAYMENTS", "TRANSFER_IN"].includes(input.primary ?? "")) return null;
  if (genericExclusions.test(input.description)) return null;
  return benefitConfig.generic.pattern.test(input.description) || genericKeywords.test(input.description)
    ? "generic"
    : null;
}
