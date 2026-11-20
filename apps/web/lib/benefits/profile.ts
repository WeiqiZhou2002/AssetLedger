import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, auditLogs, cardBenefitProfiles } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { invariant } from "@/lib/ledger/errors";
import { lockOwnerStructure } from "@/lib/snapshots/groups";
import { productById } from "./catalog";
const inputSchema = z.discriminatedUnion("mode", [
  z.object({ accountId: z.uuid(), mode: z.literal("auto") }).strict(),
  z.object({ accountId: z.uuid(), mode: z.literal("product"), productId: z.string().min(1) }).strict(),
  z.object({ accountId: z.uuid(), mode: z.literal("none") }).strict(),
]);
// Dedicated allowlist: do not broaden the shared ledger/auth redaction rules.
const auditDetails = z
  .object({
    accountId: z.uuid(),
    mode: z.enum(["auto", "product", "none"]),
    catalogProductId: z.string().nullable(),
  })
  .strict();
export async function lockBenefitAccount(db: AppDb, ownerId: string, accountId: string) {
  await lockOwnerStructure(db, ownerId);
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.ownerId, ownerId), eq(accounts.id, accountId)))
    .for("update");
  invariant(account, "账户不存在", 404);
  invariant(!account.isSystem && account.type === "liability_credit_card", "请选择信用卡账户");
  return account;
}
export async function setBenefitProfile(db: AppDb, ownerId: string, input: unknown) {
  const values = inputSchema.parse(input);
  return db.transaction(async (tx) => {
    const account = await lockBenefitAccount(tx, ownerId, values.accountId);
    const productId = values.mode === "product" ? values.productId : null;
    invariant(productId === null || productById(productId), "卡产品不在当前目录中");
    const where = and(
      eq(cardBenefitProfiles.ownerId, ownerId),
      eq(cardBenefitProfiles.accountId, account.id),
    );
    const changed =
      values.mode === "auto"
        ? await tx.delete(cardBenefitProfiles).where(where).returning({ id: cardBenefitProfiles.id })
        : await tx
            .insert(cardBenefitProfiles)
            .values({ ownerId, accountId: account.id, catalogProductId: productId })
            .onConflictDoUpdate({
              target: [cardBenefitProfiles.ownerId, cardBenefitProfiles.accountId],
              set: { catalogProductId: productId, updatedAt: new Date() },
              setWhere: sql`${cardBenefitProfiles.catalogProductId} IS DISTINCT FROM ${productId}`,
            })
            .returning({ id: cardBenefitProfiles.id });
    if (changed.length)
      await tx.insert(auditLogs).values({
        ownerId,
        actorUserId: ownerId,
        entityType: "account",
        entityId: account.id,
        action: values.mode === "product" ? "benefit_profile.set" : `benefit_profile.${values.mode}`,
        changes: auditDetails.parse({
          accountId: account.id,
          mode: values.mode,
          catalogProductId: productId,
        }),
      });
    return { accountId: account.id, mode: values.mode, productId };
  });
}
