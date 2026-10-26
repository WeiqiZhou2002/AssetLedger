import Decimal from "decimal.js";
import { z } from "zod";
// NUMERIC(20,4): amounts enter the domain as strings, never binary floats.
export const amountSchema = z.string().regex(/^-?(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/, "金额格式无效");
const MoneyDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export function money(value: string | Decimal): Decimal {
  return new MoneyDecimal(typeof value === "string" ? amountSchema.parse(value) : value);
}
export function sumMoney(values: Iterable<string | Decimal>): Decimal {
  let total = new MoneyDecimal("0");
  for (const value of values) total = total.plus(money(value));
  return total;
}
