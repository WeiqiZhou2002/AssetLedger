import { describe, expect, it } from "vitest";
import { money } from "@/lib/money";
import { benefitProgress } from "@/lib/benefits/progress";
import vectors from "./fixtures/cardfacts/credit-vectors.json";
// Ignore additive UI metadata, but compare all contract fields, array ordering and decimal values.
function contract(actual: unknown, expected: unknown): unknown {
  if (typeof expected === "string" && /^-?\d+\.\d+$/.test(expected)) {
    expect(typeof actual).toBe("string");
    expect(money(actual as string).eq(expected)).toBe(true);
    return expected;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual)).toBe(true);
    expect((actual as unknown[]).length).toBe(expected.length);
    return expected.map((value, i) => contract((actual as unknown[])[i], value));
  }
  if (expected !== null && typeof expected === "object") {
    expect(actual).toBeTruthy();
    return Object.fromEntries(
      Object.entries(expected).map(([key, value]) => [
        key,
        contract((actual as Record<string, unknown>)[key], value),
      ]),
    );
  }
  return actual;
}
describe("CardFacts credit-progress contract", () => {
  for (const vector of vectors.data.vectors) {
    it(`${vector.id}: ${vector.title}`, () => {
      const result = benefitProgress(vector);
      result.unmatched.sort((a, b) => a.entry.localeCompare(b.entry));
      const expected = {
        ...vector.expect,
        unmatched: [...vector.expect.unmatched].sort((a, b) => a.entry.localeCompare(b.entry)),
      };
      expect(contract(result, expected)).toEqual(expected);
    });
  }
});
