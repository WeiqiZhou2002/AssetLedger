import { expect, it } from "vitest";
import { detectBenefit } from "@/lib/benefits/config";
import { normalizedCreditName } from "@/lib/benefits/credit-name";

it.each([
  ["PLATINUM DIGITAL ENTERTAINMENT CREDIT", "entertainment"],
  ["AMEX UBER ONE CREDIT", "generic"],
  ["PLATINUM LULULEMON CREDIT", "generic"],
  ["AMEX RESY CREDIT", "dining"],
  ["OURA CREDIT", "generic"],
  ["WALMART+ CREDIT", "shopping"],
  ["AMEX BENEFIT CREDIT", "generic"],
  ["U.S. BANK TRAVEL CREDIT", "travel"],
  ["STREAMING CREDIT", "entertainment"],
  ["GLOBAL ENTRY CREDIT", "travel-program"],
  ["aMeX uBeR oNe CrEdIt", "generic"],
  ["AMEX-BENEFITS-CREDITS", "generic"],
  ["AMEX BENEFITS", "generic"],
  ["OURA CREDITS", "generic"],
  ["BENEFIT", "generic"],
  ["REIMBURSEMENT", "generic"],
  ["STATEMENT CREDIT", "generic"],
  ["CREDIT ADJUSTMENT", "generic"],
  ["AIRLINE FEE CREDIT", "airline"],
  ["TRAVEL CREDIT REVERSAL", "travel"],
])("detects %s as %s only for card inflows", (description, family) => {
  expect(detectBenefit({ description, accountType: "liability_credit_card", amount: "15.75" })).toBe(family);
  for (const accountType of ["asset_cash", "asset_brokerage_cash", "liability_loan"])
    expect(detectBenefit({ description, accountType, amount: "15.75" })).toBeNull();
  for (const amount of ["-15.75", "0"])
    expect(detectBenefit({ description, accountType: "liability_credit_card", amount })).toBeNull();
});
it.each([
  "CASHBACK OFFER",
  "AMEX OFFERS CASH BACK REWARD",
  "MERCHANT OFFER",
  "OFFER CREDIT",
  "AMEX RESY OFFERS CREDIT",
  "PLATINUM WIRELESS OFFER CREDIT",
  "PAYMENT THANK YOU",
  "MOBILE PAYMENT CREDIT",
  "RETURN CREDIT AMAZON",
  "LATE FEE CREDIT",
  "INTEREST CHARGE CREDIT",
  "ANNUAL FEE CREDIT",
  "FOREIGN TRANSACTION FEES CREDIT",
  "THANKYOU POINTS REDEMPTION CREDIT",
  "CASH BACK REWARD CREDIT",
  "CASH BACK REWARD STATEMENT CREDIT",
  "Example Merchant refund",
  "Example Merchant",
  "CREDITED",
  "BENEFICIAL",
  "microcredit",
  "PAYMENT THANK YOU TRAVEL CREDIT",
  "AUTOPAY DINING CREDIT",
])("does not flag %s", (description) => {
  expect(detectBenefit({ description, accountType: "liability_credit_card", amount: "15" })).toBeNull();
});
it.each([
  "OFFER",
  "OFFERS",
  "PAYMENT",
  "PAYMENTS",
  "RETURN",
  "RETURNS",
  "RETURNED",
  "REFUND",
  "REFUNDS",
  "REVERSAL",
  "REVERSED",
  "DISPUTE",
  "CHARGEBACK",
  "PROVISIONAL",
  "INTEREST",
  "FEE",
  "FEES",
  "REDEMPTION",
  "REDEEM",
  "REDEEMED",
  "REWARD",
  "REWARDS",
  "CASHBACK",
  "CASH BACK",
  "CASH-BACK",
  "POINT",
  "POINTS",
  "MILES",
  "BALANCE TRANSFER",
  "BALANCE-TRANSFER",
])("excludes standalone %s from generic keyword and legacy generic detection", (excluded) => {
  for (const name of ["AMEX BENEFIT", "OURA CREDITS", "STATEMENT CREDIT", "REIMBURSEMENT"])
    expect(
      detectBenefit({
        description: `${name.toLowerCase()}-${excluded.toLowerCase()}`,
        accountType: "liability_credit_card",
        amount: "15",
      }),
    ).toBeNull();
});
it.each([
  "PLATINUM DIGITAL ENTERTAINMENT CREDIT 01/25/2026 REF#AB1234 CARD ****9876",
  "platinum digital entertainment credit Feb 24, 2026 reference number ABCDEF card ending in 1234",
  "PLATINUM  DIGITAL   ENTERTAINMENT CREDIT 24-Mar-2026 transaction id X9-Y8 CARD LAST4 5678",
  "PLATINUM DIGITAL ENTERTAINMENT CREDIT 2026-04-24 CONFIRMATION:ZX9898 1234",
  "PLATINUM DIGITAL ENTERTAINMENT CREDIT 05/24/26 #ABC123DEF 9876",
])("normalizes dated/reference credit names: %s", (description) => {
  expect(normalizedCreditName(description, "Different merchant")).toBe("Digital Entertainment Credit");
});
it("uses merchant fallback, preserves words and provides an empty-name fallback", () => {
  expect(normalizedCreditName("  ", "amex oura credit 1234")).toBe("Oura Credit");
  expect(normalizedCreditName(null, "WALMART+ CREDIT 2026-10-24")).toBe("Walmart+ Credit");
  expect(normalizedCreditName("信用卡 权益 CREDIT 1234", null)).toBe("信用卡 权益 Credit");
  expect(normalizedCreditName("1234 2026/10/24", null)).toBe("其他权益");
  expect(normalizedCreditName(null, null)).toBe("其他权益");
});

it.each(["LOAN_PAYMENTS", "TRANSFER_IN"])(
  "keeps generic credits classified as %s eligible for payment matching",
  (primary) => {
    for (const description of [
      "ONLINE CREDIT",
      "AMEX UBER ONE CREDIT",
      "STATEMENT CREDIT",
      "CREDIT ADJUSTMENT",
      "REIMBURSEMENT",
      "AMEX BENEFIT",
    ])
      expect(
        detectBenefit({ description, primary, accountType: "liability_credit_card", amount: "15" }),
      ).toBeNull();
    expect(
      detectBenefit({
        description: "AIRLINE FEE CREDIT",
        primary,
        accountType: "liability_credit_card",
        amount: "15",
      }),
    ).toBe("airline");
    expect(
      detectBenefit({
        description: "AMEX OFFERS CREDIT",
        primary,
        accountType: "liability_credit_card",
        amount: "15",
      }),
    ).toBeNull();
    expect(
      detectBenefit({
        description: "AMEX UBER ONE CREDIT",
        primary: "GENERAL_MERCHANDISE",
        accountType: "liability_credit_card",
        amount: "15",
      }),
    ).toBe("generic");
  },
);

it.each([
  ["AMEX CHATGPT CREDIT 10/12", "ChatGPT Credit"],
  ["PLATINUM WIRELESS CREDIT", "Wireless Credit"],
  ["PLATINUM DIGITAL ENTERTAINMENT CREDIT", "Digital Entertainment Credit"],
  ["AMERICAN EXPRESS BUSINESS GOLD OPENAI BENEFIT", "OpenAI Benefit"],
  [
    "CITI CITIBANK CHASE SAPPHIRE RESERVE US BANK U.S. BANK CAPITAL ONE VENTURE X BILT ALTITUDE CARD CARDMEMBER STATEMENT ADJUSTMENT YOUTUBE CREDITS",
    "YouTube Credit",
  ],
  ["AMEX BENEFIT CREDIT", "其他权益"],
  ["AMEX DISNEY+ CREDIT", "Disney+ Credit"],
  ["AMEX CLEAR BENEFITS", "CLEAR Benefit"],
  ["AMEX UBER ONE CREDIT", "Uber One Credit"],
])("labels %s as concise credit type %s", (description, expected) => {
  expect(normalizedCreditName(description, null)).toBe(expected);
});
