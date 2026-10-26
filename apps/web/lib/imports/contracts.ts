import { z } from "zod";
import { amountSchema } from "@/lib/money";
import { dateSchema } from "@/lib/ledger/schemas";
import { directions } from "./types";
const optionalDate = dateSchema.nullable().optional();
const optionalAmount = amountSchema.optional();
export const parsedRowSchema = z.object({
  transaction_date: optionalDate,
  posted_date: optionalDate,
  description_raw: z.string().max(2000),
  merchant_normalized: z.string().max(2000),
  amount_raw: z.string().max(100),
  amount: amountSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  direction: z.enum(directions),
  confidence: z.coerce.string().regex(/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/),
  source_page: z.number().int().positive().nullable().optional(),
  source_row_text: z.string().max(4000),
  provider_transaction_id: z.string().max(200).nullable().optional(),
});
const diagnosticSchema = z.object({
  kind: z.string().regex(/^[a-z0-9_:-]+$/),
  page: z.number().int().positive().optional(),
  count: z.number().int().nonnegative().optional(),
  severity: z.enum(["info", "warning"]),
});
const transactionLineSchema = z.object({
  page: z.number().int().positive(),
  text: z.string().max(2000),
});
const summarySchema = z.object({
  previous_balance: optionalAmount,
  ending_balance: optionalAmount,
  payments: optionalAmount,
  credits: optionalAmount,
  purchases: optionalAmount,
  deposits: optionalAmount,
  withdrawals: optionalAmount,
  fees: optionalAmount,
  interest: optionalAmount,
  balance_transfers: optionalAmount,
  advances: optionalAmount,
  other_debits: optionalAmount,
  minimum_payment: optionalAmount,
  payment_due_date: dateSchema.optional(),
  rewards: z
    .object({
      earned: z.string().regex(/^\d+$/).optional(),
      total: z.string().regex(/^\d+$/).optional(),
      as_of: dateSchema.optional(),
    })
    .optional(),
  daily_balances: z
    .array(z.object({ date: dateSchema, balance: amountSchema }))
    .max(500)
    .optional(),
  sections: z
    .array(
      z.object({
        name: z.string().max(100),
        direction: z.enum(directions),
        printed_total: amountSchema,
        parsed_total: amountSchema,
      }),
    )
    .max(500)
    .optional(),
  checks: z
    .array(
      z.object({
        kind: z.string().max(100),
        expected: amountSchema,
        actual: amountSchema,
        matches: z.boolean(),
      }),
    )
    .max(1000)
    .optional(),
});
export const statementResultSchema = z.object({
  issuer: z.string().max(200).nullable().optional(),
  statement_type: z.enum(["credit_card", "bank", "unknown"]),
  account_last4: z
    .string()
    .regex(/^\d{4}$/)
    .nullable()
    .optional(),
  statement_start: optionalDate,
  statement_end: optionalDate,
  currency: z.string().regex(/^[A-Z]{3}$/),
  page_count: z.number().int().positive(),
  parser: z.string().max(100),
  parser_version: z.string().max(40),
  entries: z.array(parsedRowSchema).max(10000),
  summary: summarySchema,
  diagnostics: z.array(diagnosticSchema).max(10000),
  transaction_lines: z.array(transactionLineSchema).max(10000),
});
export type ParsedRow = z.infer<typeof parsedRowSchema>;
export type StatementResult = z.infer<typeof statementResultSchema>;
export const csvMappingSchema = z
  .object({
    dateColumn: z.string().min(1).max(200),
    dateFormat: z.enum(["MM/DD/YYYY", "YYYY-MM-DD", "MM/DD/YY"]),
    descriptionColumn: z.string().min(1).max(200),
    amountColumn: z.string().max(200).optional(),
    debitColumn: z.string().max(200).optional(),
    creditColumn: z.string().max(200).optional(),
    referenceColumn: z.string().max(200).optional(),
    signConvention: z.enum(["account_signed", "positive_charge"]),
    skipRows: z.number().int().min(0).max(100).default(0),
  })
  .strict()
  .refine(
    (row) => Boolean(row.amountColumn) !== Boolean(row.debitColumn && row.creditColumn),
    "请选择单列金额或借贷两列",
  );
