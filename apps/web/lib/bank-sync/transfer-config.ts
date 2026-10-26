import { money } from "@/lib/money";

// Shared by sync processing, old undecided rows, and upstream changes.
import { detectBenefit, isMerchantOfferRefund } from "@/lib/benefits/config";
import { paymentKeywords } from "@/lib/benefits/payment-keywords";
export { paymentKeywords } from "@/lib/benefits/payment-keywords";
export const transferKeywords = [
  ...paymentKeywords,
  /\b(?:fund(?:ing|ed)?|add[\s-]+money|top[\s-]+up|load|card[\s-]+deposit|instant[\s-]+transfer|deposit[\s-]+from)\b/i,
  /\b(?:zelle|venmo|transfer|xfer)\b/i,
  /\b(?:to|from)\s+(?:an?\s+)?account\b/i,
];
export const isZelle = (description: string) => /\bzelle\b/i.test(description);
export function isCashDeposit(input: { amount: string; accountType: string; description: string }) {
  return (
    ["asset_cash", "asset_brokerage_cash"].includes(input.accountType) &&
    money(input.amount).gt(0) &&
    /\b(?:atm|cash|branch|mobile)[\s-]+deposit\b/i.test(input.description)
  );
}
export function isCashAdvanceSpend(input: { amount: string; accountType: string; description: string }) {
  return (
    ["asset_cash", "asset_brokerage_cash"].includes(input.accountType) &&
    money(input.amount).lt(0) &&
    /\bcash[\s-]+advance\b/i.test(input.description)
  );
}
export function isTransferLike(input: {
  amount: string;
  accountType: string;
  description: string;
  primary?: string | null;
}) {
  if (detectBenefit(input) || isMerchantOfferRefund(input)) return false;
  if (
    isCashDeposit(input) ||
    isCashAdvanceSpend(input) ||
    (["asset_cash", "asset_brokerage_cash"].includes(input.accountType) && isZelle(input.description))
  )
    return false;
  if (input.accountType === "liability_credit_card" && money(input.amount).gt(0))
    return (
      ["LOAN_PAYMENTS", "TRANSFER_IN"].includes(input.primary ?? "") ||
      paymentKeywords.some((keyword) => keyword.test(input.description))
    );
  return (
    ["TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"].includes(input.primary ?? "") ||
    transferKeywords.some((keyword) => keyword.test(input.description))
  );
}
