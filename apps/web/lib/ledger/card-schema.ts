import { z } from "zod";

function isAmexNumber(number: string) {
  return /^3[47]\d{13}$/.test(number);
}
function luhn(number: string) {
  let sum = 0;
  for (let i = number.length - 1, double = false; i >= 0; i--, double = !double) {
    let digit = Number(number[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0 && !/^0+$/.test(number);
}
export function cardNetwork(number: string): "visa" | "mastercard" | "amex" | "discover" | "other" {
  if (isAmexNumber(number)) return "amex";
  if (/^4/.test(number)) return "visa";
  const prefix = number.slice(0, 4);
  if (/^5[1-5]/.test(number) || (prefix >= "2221" && prefix <= "2720")) return "mastercard";
  const six = number.slice(0, 6);
  if (/^(6011|65|64[4-9])/.test(number) || (six >= "622126" && six <= "622925")) return "discover";
  return "other";
}
export const cardSchema = z
  .object({
    number: z
      .string({ error: "请输入卡号" })
      .max(64, "卡号过长")
      .transform((value) => value.replace(/[\s-]/g, ""))
      .pipe(
        z
          .string()
          .regex(/^\d{12,19}$/, "卡号须为 12–19 位数字")
          .refine(luhn, "卡号校验失败，请检查数字"),
      ),
    expMonth: z
      .string({ error: "请输入有效期月份" })
      .regex(/^(0?[1-9]|1[0-2])$/, "有效期月份须为 1–12")
      .transform((value) => value.padStart(2, "0")),
    expYear: z
      .string({ error: "请输入有效期年份" })
      .regex(/^(\d{2}|\d{4})$/, "有效期年份须为 2 位或 4 位数字")
      .transform((value) => (value.length === 2 ? `20${value}` : value)),
    cvv: z
      .string({ error: "CVV 须为数字文本" })
      .regex(/^\d{3,4}$/, "CVV 须为 3–4 位数字")
      .optional(),
    cid: z
      .string({ error: "CID 须为数字文本" })
      .regex(/^\d{4}$/, "正面 CID 须为 4 位数字")
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (isAmexNumber(value.number)) {
      if (value.cvv && value.cvv.length !== 3)
        ctx.addIssue({ code: "custom", path: ["cvv"], message: "Amex 背面 CVV 须为 3 位数字" });
    } else if (value.cid !== undefined) {
      ctx.addIssue({ code: "custom", path: ["cid"], message: "只有 Amex 可保存正面 CID" });
    }
  });
export type CardPayload = z.output<typeof cardSchema>;
