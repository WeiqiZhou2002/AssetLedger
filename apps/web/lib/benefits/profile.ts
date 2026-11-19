import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { accounts, auditLogs, cardBenefitProfiles } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { invariant } from "@/lib/ledger/errors";
import { lockOwnerStructure } from "@/lib/snapshots/groups";
import { productById } from "./catalog";
const inputSchema = z
  .object({
    accountId: z.uuid(),
    productId: z.string().min(1).nullable(),
    trackingStart: z.iso.date().nullable().optional(),
  })
  .strict();
// Dedicated allowlist: do not broaden the shared ledger/auth redaction rules.
const auditDetails = z
  .object({
    accountId: z.uuid(),
    catalogProductId: z.string().nullable(),
    trackingStart: z.iso.date().nullable(),
  })
  .strict();
export async function setBenefitProfile(db: AppDb, ownerId: string, input: unknown) {
  const values = inputSchema.parse(input);
  return db.transaction(async (tx) => {
    await lockOwnerStructure(tx, ownerId);
    const [account] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.ownerId, ownerId), eq(accounts.id, values.accountId)))
      .for("update");
    invariant(account, "账户不存在", 404);
    invariant(!account.isSystem && account.type === "liability_credit_card", "请选择信用卡账户");
    invariant(values.productId === null || productById(values.productId), "卡产品不在当前目录中");
    const where = and(
      eq(cardBenefitProfiles.ownerId, ownerId),
      eq(cardBenefitProfiles.accountId, account.id),
    );
    const [existing] = await tx.select().from(cardBenefitProfiles).where(where);
    const trackingStart =
      values.productId === null
        ? null
        : values.trackingStart === undefined
          ? (existing?.trackingStart ?? null)
          : values.trackingStart;
    if (values.productId === null) await tx.delete(cardBenefitProfiles).where(where);
    else
      await tx
        .insert(cardBenefitProfiles)
        .values({ ownerId, accountId: account.id, catalogProductId: values.productId, trackingStart })
        .onConflictDoUpdate({
          target: [cardBenefitProfiles.ownerId, cardBenefitProfiles.accountId],
          set: { catalogProductId: values.productId, trackingStart, updatedAt: new Date() },
        });
    await tx.insert(auditLogs).values({
      ownerId,
      actorUserId: ownerId,
      entityType: "account",
      entityId: account.id,
      action: values.productId === null ? "benefit_profile.clear" : "benefit_profile.set",
      changes: auditDetails.parse({
        accountId: account.id,
        catalogProductId: values.productId,
        trackingStart,
      }),
    });
    return { accountId: account.id, productId: values.productId, trackingStart };
  });
}
