import { z } from "zod";
import { money } from "./index";
// Calculated values and FX rates retain more precision than stored native money.
const decimalSchema = z
  .string()
  .max(100)
  .regex(/^-?\d+(?:\.\d+)?$/);
export function decimal(value: string) {
  return money("0").plus(decimalSchema.parse(value));
}
export const rateSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,10})?$/)
  .refine((value) => decimal(value).gt(0), "汇率必须大于零");
export function daysBetween(from: string, to: string) {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}
export function isStale(observedOn: string, asOf: string, days: number) {
  return daysBetween(observedOn, asOf) > days;
}
