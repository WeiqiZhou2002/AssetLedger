import { expect, it } from "vitest";
import { amountSchema, sumMoney } from "@/lib/money";
it("sums decimal strings exactly (§12 test 13)", () => {
  expect(sumMoney(Array(3).fill("0.1")).toFixed(2)).toBe("0.30");
  expect(sumMoney(Array(100).fill("0.01")).toFixed(2)).toBe("1.00");
  expect(sumMoney(["1.0001", "-1", "0.0001"]).toFixed(4)).toBe("0.0002");
});
it("rejects JS numbers, scientific notation and excess scale", () => {
  for (const value of [0.1, "1e4", "NaN", "0.00001", "10000000000000000"])
    expect(amountSchema.safeParse(value).success).toBe(false);
});
