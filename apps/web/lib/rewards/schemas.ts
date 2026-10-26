import { z } from "zod";
import { decimal } from "@/lib/money/fx";
import { dateSchema } from "@/lib/ledger/schemas";
import { programKinds, manualEventTypes } from "./constants";
export const pointsSchema = z
  .string()
  .max(20)
  .regex(/^-?(?:0|[1-9]\d*)$/)
  .refine((value) => {
    if (!/^-?(?:0|[1-9]\d*)$/.test(value)) return false;
    const points = BigInt(value);
    return points >= -9223372036854775808n && points <= 9223372036854775807n;
  }, "点数超出整数范围");
const positivePoints = pointsSchema.refine(
  (value) => /^\d+$/.test(value) && BigInt(value) > 0n,
  "点数须大于零",
);
const cppSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,5})(?:\.\d{1,4})?$/)
  .refine((value) => decimal(value).gte(0));
const note = z.string().trim().max(2000).nullable().optional();
export const programSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Z0-9_]{1,30}$/),
    name: z.string().trim().min(1).max(100),
    kind: z.enum(programKinds),
    unitLabel: z.string().trim().min(1).max(20).optional(),
    isArchived: z.boolean().optional(),
  })
  .strict();
export const accountSchema = z
  .object({
    programId: z.uuid(),
    name: z.string().trim().min(1).max(100),
    memberLast4: z
      .string()
      .regex(/^[A-Za-z0-9]{4}$/)
      .nullable()
      .optional(),
    linkedCardAccountId: z.uuid().nullable().optional(),
    isActive: z.boolean().optional(),
    notes: note,
  })
  .strict();
export const eventSchema = z
  .object({
    loyaltyAccountId: z.uuid(),
    eventDate: dateSchema,
    pointsDelta: pointsSchema.refine(
      (value) => /^-?\d+$/.test(value) && BigInt(value) !== 0n,
      "点数不能为零",
    ),
    type: z.enum(manualEventTypes),
    relatedJournalEntryId: z.uuid().nullable().optional(),
    externalReference: z.string().max(200).nullable().optional(),
    note,
  })
  .strict();
export const observationSchema = z
  .object({ loyaltyAccountId: z.uuid(), observedOn: dateSchema, balance: pointsSchema })
  .strict();
export const transferSchema = z
  .object({
    fromAccountId: z.uuid(),
    toAccountId: z.uuid(),
    fromPoints: positivePoints,
    toPoints: positivePoints,
    eventDate: dateSchema,
    note,
  })
  .strict();
export const cppHistorySchema = z
  .object({
    programId: z.uuid(),
    effectiveDate: dateSchema,
    cppBaseline: cppSchema,
    cppPersonal: cppSchema,
    note,
  })
  .strict();
