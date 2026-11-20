import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, cardBenefitMarks, cardBenefitProfiles, institutions, users } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { invariant } from "@/lib/ledger/errors";
import { todayInTimezone } from "@/lib/ledger/format";
import { effectiveBenefitProduct, linkedBenefitNames } from "./effective-product";
import { benefitMatchNames } from "./catalog/match-product";
import { lockBenefitAccount } from "./profile";
import { addYears } from "./progress/dates";
const inputSchema = z
  .object({
    accountId: z.uuid(),
    productId: z.string().min(1),
    creditId: z.string().min(1),
    periodStart: z.iso.date(),
    periodEnd: z.iso.date(),
    marked: z.boolean(),
  })
  .strict();
const auditDetails = z
  .object({
    accountId: z.uuid(),
    catalogProductId: z.string(),
    creditId: z.string(),
    periodStart: z.iso.date(),
    periodEnd: z.iso.date(),
  })
  .strict();
export async function setBenefitMark(db: AppDb, ownerId: string, input: unknown) {
  const values = inputSchema.parse(input);
  return db.transaction(async (tx) => {
    const account = await lockBenefitAccount(tx, ownerId, values.accountId);
    const [profiles, names, institutionRows, owners] = await Promise.all([
      tx
        .select({ catalogProductId: cardBenefitProfiles.catalogProductId })
        .from(cardBenefitProfiles)
        .where(and(eq(cardBenefitProfiles.ownerId, ownerId), eq(cardBenefitProfiles.accountId, account.id))),
      linkedBenefitNames(tx, ownerId, account.id),
      account.institutionId
        ? tx
            .select({ name: institutions.name })
            .from(institutions)
            .where(and(eq(institutions.ownerId, ownerId), eq(institutions.id, account.institutionId)))
        : [],
      tx.select({ timezone: users.timezone }).from(users).where(eq(users.id, ownerId)),
    ]);
    const effective = effectiveBenefitProduct({
      profile: profiles[0],
      institution: institutionRows[0]?.name ?? null,
      names: benefitMatchNames(account.name, names),
    });
    invariant(effective.product?.id === values.productId, "卡产品已更改，请刷新后重试");
    invariant(
      effective.product.credits.some(
        (credit) => credit.id === values.creditId && credit.delivery === "statement_credit",
      ),
      "该报销项目不属于当前卡产品",
    );
    invariant(values.periodStart <= todayInTimezone(owners[0].timezone), "周期开始日期不能晚于今天");
    invariant(
      values.periodEnd >= values.periodStart && values.periodEnd <= addYears(values.periodStart, 10),
      "周期结束日期须在开始日期至十年内",
    );
    const key = {
      ownerId,
      accountId: account.id,
      catalogProductId: values.productId,
      creditId: values.creditId,
      periodStart: values.periodStart,
    };
    const changed = values.marked
      ? await tx
          .insert(cardBenefitMarks)
          .values({ ...key, periodEnd: values.periodEnd })
          .onConflictDoUpdate({
            target: [
              cardBenefitMarks.ownerId,
              cardBenefitMarks.accountId,
              cardBenefitMarks.catalogProductId,
              cardBenefitMarks.creditId,
              cardBenefitMarks.periodStart,
            ],
            set: { periodEnd: values.periodEnd, updatedAt: new Date() },
            setWhere: ne(cardBenefitMarks.periodEnd, values.periodEnd),
          })
          .returning({ id: cardBenefitMarks.id })
      : await tx
          .delete(cardBenefitMarks)
          .where(
            and(
              eq(cardBenefitMarks.ownerId, ownerId),
              eq(cardBenefitMarks.accountId, account.id),
              eq(cardBenefitMarks.catalogProductId, values.productId),
              eq(cardBenefitMarks.creditId, values.creditId),
              eq(cardBenefitMarks.periodStart, values.periodStart),
            ),
          )
          .returning({ id: cardBenefitMarks.id });
    if (changed.length)
      await tx.insert(auditLogs).values({
        ownerId,
        actorUserId: ownerId,
        entityType: "account",
        entityId: account.id,
        action: values.marked ? "benefit_mark.set" : "benefit_mark.clear",
        changes: auditDetails.parse({
          accountId: account.id,
          catalogProductId: values.productId,
          creditId: values.creditId,
          periodStart: values.periodStart,
          periodEnd: values.periodEnd,
        }),
      });
    return values;
  });
}
