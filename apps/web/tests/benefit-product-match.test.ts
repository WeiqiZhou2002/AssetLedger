import { expect, it } from "vitest";
import { catalog } from "@/lib/benefits/catalog";
import { benefitMatchNames, matchProduct, rankProducts } from "@/lib/benefits/catalog/match-product";
import { syntheticCatalog } from "./helpers/benefit-catalog";
it.each([
  ["American Express", ["Platinum Card®"], "us-amex-platinum"],
  ["American Express", ["Platinum Card®", "我的白金卡"], "us-amex-platinum"],
  [null, ["Platinum Card", "Amex"], "us-amex-platinum"],
  ["American Express", ["Business Platinum Card®"], "us-amex-business-platinum"],
  ["American Express", ["Gold Card"], "us-amex-gold"],
  ["American Express", ["Delta SkyMiles® Reserve Card"], "us-amex-delta-skymiles-reserve"],
  ["American Express", ["Blue Cash Everyday®"], "us-amex-blue-cash-everyday"],
  ["Chase", ["CREDIT CARD", "Sapphire Reserve"], "us-chase-sapphire-reserve"],
  ["Chase", ["Sapphire Preferred"], "us-chase-sapphire-preferred"],
  ["Capital One", ["VENTURE X"], "us-capital-one-venture-x"],
  ["Chase", ["CREDIT CARD"], null],
  [null, ["Platinum Card"], null],
  [null, ["Amex Platinum"], "us-amex-platinum"],
] as const)("matches %s / %j", (institution, names, expected) => {
  expect(matchProduct({ institution, names: [...names] }, catalog)?.productId ?? null).toBe(expected);
});
it("handles ties, aliases, empty tokens, Unicode, issuer phrases and ranking limits", () => {
  const sample = syntheticCatalog();
  const input = { institution: "Example Bank", names: ["ＶＯＹＡＧＥＲ™ 1234"] };
  expect(matchProduct(input, sample)).toBeNull();
  expect(rankProducts(input, sample, 1)).toEqual(["example-other"]);
  sample.cards[1].aliases = [];
  expect(matchProduct(input, sample)).toEqual({ productId: "example-voyager", score: 1 });
  expect(rankProducts({ institution: null, names: ["Credit Card 1234 ®℠©"] }, sample)).toEqual([]);
  sample.cards[0].issuer = "Citi";
  sample.cards[1].issuer = "Chase";
  sample.cards[1].name = "Voyager Card";
  expect(matchProduct({ institution: "Citizens Bank", names: ["Voyager"] }, sample)).toBeNull();
  expect(rankProducts({ institution: "Chase", names: ["Citi Voyager"] }, sample)).toEqual(["example-other"]);
  expect(matchProduct({ institution: null, names: ["ChaseVoyager"] }, sample)).toBeNull();
});

it("uses the normalized name for any unknown catalog issuer", () => {
  const sample = syntheticCatalog();
  sample.cards = [sample.cards[0]];
  sample.cards[0].issuer = "Constructor";
  expect(matchProduct({ institution: "Constructor", names: ["Voyager Card"] }, sample)).toEqual({
    productId: "example-voyager",
    score: 1,
  });
});

it.each([
  [
    "American Express",
    "Platinum Card",
    "CREDIT CARD",
    "Business Platinum Card®",
    "us-amex-business-platinum",
  ],
  ["Chase", "我的旅行卡", "CREDIT CARD", "Sapphire Reserve", "us-chase-sapphire-reserve"],
] as const)("prefers the Plaid official name for %s", (institution, ledger, name, officialName, expected) => {
  const names = benefitMatchNames(ledger, [{ name, officialName }]);
  expect(names).toEqual([officialName, name, ledger]);
  expect(matchProduct({ institution, names }, catalog)?.productId).toBe(expected);
});
it("orders all official names before Plaid names and the ledger name, removing blanks and duplicates", () => {
  expect(
    benefitMatchNames(" Ledger ", [
      { officialName: " Official One ", name: " Plaid One " },
      { officialName: "Official Two", name: "Plaid Two" },
      { officialName: "Official One", name: "Official Two" },
      { officialName: null, name: " " },
      { officialName: " ", name: "Plaid One" },
    ]),
  ).toEqual(["Official One", "Official Two", "Plaid One", "Plaid Two", "Ledger"]);
  expect(benefitMatchNames("Official One", [{ officialName: "Official One", name: "Plaid One" }])).toEqual([
    "Official One",
    "Plaid One",
  ]);
  expect(benefitMatchNames(" ", [])).toEqual([]);
});
it("returns the first confident name but ranks products by their maximum score across names", () => {
  const sample = syntheticCatalog();
  sample.cards[1].aliases = ["Other"];
  const input = { institution: "Example Bank", names: ["Voyager", "Other"] };
  expect(matchProduct(input, sample)).toEqual({ productId: "example-voyager", score: 1 });
  expect(rankProducts(input, sample)).toEqual(["example-other", "example-voyager"]);
  const fallback = { ...input, names: ["Voyager Extra", "Other"] };
  expect(matchProduct(fallback, sample)).toEqual({ productId: "example-other", score: 1 });
  expect(rankProducts(fallback, sample)).toEqual(["example-other", "example-voyager"]);
  sample.cards[1].aliases = ["Voyager"];
  expect(matchProduct(input, sample)).toEqual({ productId: "example-other", score: 1 });
});
