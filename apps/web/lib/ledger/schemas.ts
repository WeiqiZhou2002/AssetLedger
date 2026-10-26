import { benefitFamilies } from "@/lib/benefits/config";
import { z } from "zod";
import { amountSchema, money } from "@/lib/money";
import { accountTypes, entryTypes, systemTypes, type SystemType } from "./constants";
export const currencySchema = z.string().regex(/^[A-Z]{3}$/);
export const dateSchema = z.iso.date();
const optionalText = z.string().trim().max(2000).nullable().optional();
const optionalId = z.uuid().nullable().optional();
export const nonzeroAmount = amountSchema.refine((value) => !money(value).isZero(), "金额不能为零");
const positiveAmount = amountSchema.refine((value) => money(value).gt(0), "金额必须大于零");
export const institutionSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind: z.enum(["bank", "card_issuer", "brokerage", "wallet", "other"]),
    notes: optionalText,
  })
  .strict();
export const accountSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    type: z
      .enum(accountTypes)
      .refine((type) => !systemTypes.includes(type as SystemType), "系统科目由账本自动管理"),
    currency: currencySchema,
    institutionId: optionalId,
    institution: institutionSchema.optional(),
    accountGroupId: optionalId,
    last4: z
      .string()
      .regex(/^\d{4,5}$/)
      .nullable()
      .optional(),
    isActive: z.boolean().optional(),
    cashLikeInclusion: z.boolean().optional(),
    financialInclusion: z.boolean().optional(),
    openedOn: dateSchema.nullable().optional(),
    closedOn: dateSchema.nullable().optional(),
    statementDay: z.number().int().min(1).max(31).nullable().optional(),
    paymentDueDay: z.number().int().min(1).max(31).nullable().optional(),
    balanceReminderDays: z
      .union([z.literal(1), z.literal(3), z.literal(7), z.literal(14), z.literal(30)])
      .nullable()
      .optional(),
    sortOrder: z.number().int().min(-10000).max(10000).optional(),
    notes: optionalText,
  })
  .strict();
export const accountPatchSchema = accountSchema.partial().refine((value) => Object.keys(value).length > 0);
export const categorySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(["expense", "income"]),
    parentId: optionalId,
    icon: z.string().max(40).nullable().optional(),
    sortOrder: z.number().int().min(-10000).max(10000).optional(),
    isArchived: z.boolean().optional(),
  })
  .strict();
export const categoryPatchSchema = categorySchema.partial().refine((value) => Object.keys(value).length > 0);
export const postingSchema = z
  .object({
    accountId: z.uuid(),
    categoryId: optionalId,
    amount: nonzeroAmount,
    currency: currencySchema,
    memo: optionalText,
  })
  .strict();
export const entrySchema = z
  .object({
    entryType: z.enum(entryTypes),
    benefitCredit: z.boolean().default(false),
    benefitFamily: z.enum(benefitFamilies).nullable().optional(),
    isSummary: z.boolean().default(false),
    status: z.enum(["draft", "confirmed"]).default("confirmed"),
    eventDate: dateSchema,
    postedDate: dateSchema.nullable().optional(),
    merchant: z.string().trim().max(200).nullable().optional(),
    description: optionalText,
    notes: optionalText,
    source: z.enum(["manual", "import", "legacy", "system"]).default("manual"),
    purchaseGroupId: optionalId,
    refundOfEntryId: optionalId,
    externalReference: z.string().max(200).nullable().optional(),
    postings: z.array(postingSchema).min(2).max(100),
  })
  .strict();
export type EntryInput = z.input<typeof entrySchema>;
export type ValidEntry = z.output<typeof entrySchema>;
export type PostingInput = z.output<typeof postingSchema>;
export const metaSchema = z
  .object({
    merchant: z.string().trim().max(200).nullable().optional(),
    description: optionalText,
    notes: optionalText,
    categories: z
      .array(z.object({ postingId: z.uuid(), categoryId: z.uuid() }).strict())
      .max(100)
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
export const groupSchema = z
  .object({
    title: z.string().trim().min(1).max(150),
    confirmedTotal: amountSchema
      .refine((value) => money(value).gte(0))
      .nullable()
      .optional(),
    currency: currencySchema,
    categoryId: optionalId,
    notes: optionalText,
  })
  .strict();
export const groupPatchSchema = groupSchema.partial().refine((value) => Object.keys(value).length > 0);
export const settingsSchema = z
  .object({ prepaymentMode: z.enum(["asset", "expense"]), spendingDateBasis: z.enum(["posted", "event"]) })
  .strict();
export const quickSchema = z
  .object({
    type: z.enum(entryTypes),
    isSummary: z.boolean().default(false),
    amount: nonzeroAmount,
    fromAccountId: optionalId,
    toAccountId: optionalId,
    categoryId: optionalId,
    feeAmount: positiveAmount.optional(),
    feeCategoryId: optionalId,
    toAmount: positiveAmount.optional(),
    interestDirection: z.enum(["expense", "income"]).default("expense"),
    eventDate: dateSchema,
    postedDate: dateSchema.nullable().optional(),
    merchant: z.string().trim().max(200).nullable().optional(),
    description: optionalText,
    notes: optionalText,
    status: z.enum(["draft", "confirmed"]).default("confirmed"),
    purchaseGroupId: optionalId,
    refundOfEntryId: optionalId,
  })
  .strict();
export type QuickInput = z.input<typeof quickSchema>;
export const filtersSchema = z
  .object({
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    basis: z.enum(["posted", "event"]).default("posted"),
    accountId: z.uuid().optional(),
    categoryId: z.uuid().optional(),
    type: z.enum(entryTypes).optional(),
    status: z.enum(["draft", "confirmed", "voided"]).optional(),
    merchant: z.string().max(200).optional(),
    minAmount: amountSchema.refine((value) => money(value).gte(0)).optional(),
    maxAmount: amountSchema.refine((value) => money(value).gte(0)).optional(),
    currency: currencySchema.optional(),
    view: z.enum(["spending", "income", "cashflow", "all"]).default("all"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to, "开始日期不能晚于结束日期")
  .refine(
    (value) => !value.minAmount || !value.maxAmount || money(value.minAmount).lte(value.maxAmount),
    "金额范围无效",
  );
export type EntryFilters = z.input<typeof filtersSchema>;
