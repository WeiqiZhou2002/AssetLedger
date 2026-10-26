import { z } from "zod";
import { amountSchema } from "@/lib/money";
import { rateSchema } from "@/lib/money/fx";
import { currencySchema, dateSchema } from "@/lib/ledger/schemas";
export const fxSchema = z
  .object({
    baseCurrency: currencySchema,
    quoteCurrency: currencySchema,
    rate: rateSchema,
    observedOn: dateSchema,
    source: z.string().trim().min(1).max(200),
    isManual: z.boolean().default(true),
  })
  .strict()
  .refine((value) => value.baseCurrency !== value.quoteCurrency, "基准币种无需汇率");
export const frozenFxSchema = z
  .object({
    quoteCurrency: currencySchema,
    rate: rateSchema,
    observedOn: dateSchema,
    source: z.string().trim().min(1).max(200),
    fxRateId: z.uuid().nullable().optional(),
  })
  .strict();
export const snapshotItemSchema = z
  .object({
    accountId: z.uuid().nullable().optional(),
    accountGroupId: z.uuid().nullable().optional(),
    balanceNative: amountSchema,
    currency: currencySchema,
    sourceRef: z.string().max(500).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.accountId) !== Boolean(value.accountGroupId), "选择一个账户或账户组");
export const snapshotSchema = z
  .object({
    snapshotDate: dateSchema,
    label: z.string().trim().min(1).max(150),
    notes: z.string().max(2000).nullable().optional(),
    items: z.array(snapshotItemSchema).max(500),
    fx: z.array(frozenFxSchema).max(100).default([]),
  })
  .strict();
export const snapshotPatchSchema = snapshotSchema
  .partial()
  .extend({
    fx: z.array(frozenFxSchema).max(100).optional(),
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export type SnapshotInput = z.input<typeof snapshotSchema>;
export type ItemInput = z.output<typeof snapshotItemSchema>;
export type FrozenFxInput = z.output<typeof frozenFxSchema>;
