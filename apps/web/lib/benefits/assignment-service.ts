import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  auditLogs,
  cardBenefitAssignments,
  cardBenefitProfiles,
  institutions,
  journalEntries,
  postings,
} from "@/db/schema";
import type { AppDb } from "@/db/types";
import { invariant } from "@/lib/ledger/errors";
import { isMerchantOfferRefund } from "./config";
import { benefitMatchNames } from "./catalog/match-product";
import { effectiveBenefitProduct, linkedBenefitNames } from "./effective-product";
import { lockBenefitAccount } from "./profile";
import { benefitLineage, replacementChain } from "./assignments";

const base = { entryId: z.uuid(), productId: z.string().min(1) };
const inputSchema = z.discriminatedUnion("mode", [
  z.object({ ...base, mode: z.literal("auto") }).strict(),
  z.object({ ...base, mode: z.literal("credit"), creditId: z.string().min(1) }).strict(),
  z.object({ ...base, mode: z.literal("none") }).strict(),
]);
const auditDetails = z
  .object({
    entryId: z.uuid(),
    accountId: z.uuid(),
    catalogProductId: z.string(),
    creditId: z.string().nullable(),
  })
  .strict();
export async function setBenefitAssignment(db: AppDb, ownerId: string, input: unknown) {
  const values = inputSchema.parse(input);
  return db.transaction(async (tx) => {
    const resolve = () =>
      tx
        .select({ entry: journalEntries, accountId: accounts.id, amount: postings.amount })
        .from(journalEntries)
        .innerJoin(
          postings,
          and(eq(postings.journalEntryId, journalEntries.id), eq(postings.ownerId, ownerId)),
        )
        .innerJoin(accounts, and(eq(accounts.id, postings.accountId), eq(accounts.ownerId, ownerId)))
        .where(
          and(
            eq(journalEntries.ownerId, ownerId),
            eq(journalEntries.id, values.entryId),
            eq(accounts.isSystem, false),
            eq(accounts.type, "liability_credit_card"),
          ),
        );
    const [initial] = await resolve();
    invariant(initial, "权益退款不存在", 404);
    const account = await lockBenefitAccount(tx, ownerId, initial.accountId);
    // Recheck after acquiring the account/owner lock; serialize against metadata edits and voids.
    const [row] = await resolve().for("update", { of: journalEntries });
    invariant(row, "权益退款不存在", 404);
    invariant(
      row.entry.status === "confirmed" &&
        row.entry.entryType === "refund" &&
        row.entry.benefitCredit &&
        row.entry.benefitFamily !== "offer" &&
        !isMerchantOfferRefund({
          accountType: "liability_credit_card",
          amount: row.amount,
          description: `${row.entry.description ?? ""} ${row.entry.merchant ?? ""}`,
        }),
      "只能归属已确认的权益退款",
    );
    const [profiles, names, institutionRows] = await Promise.all([
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
    ]);
    const effective = effectiveBenefitProduct({
      profile: profiles[0],
      institution: institutionRows[0]?.name ?? null,
      names: benefitMatchNames(account.name, names),
    });
    invariant(effective.product?.id === values.productId, "卡产品已更改，请刷新后重试");
    if (values.mode === "credit")
      invariant(
        effective.product.credits.some(
          (credit) =>
            credit.id === values.creditId && (!credit.delivery || credit.delivery === "statement_credit"),
        ),
        "该报销项目不属于当前卡产品",
      );
    const creditId = values.mode === "credit" ? values.creditId : null;
    const changed =
      values.mode === "auto"
        ? await tx
            .delete(cardBenefitAssignments)
            .where(
              and(
                eq(cardBenefitAssignments.ownerId, ownerId),
                eq(cardBenefitAssignments.catalogProductId, values.productId),
                inArray(
                  cardBenefitAssignments.entryId,
                  replacementChain(values.entryId, await benefitLineage(tx, ownerId, [values.entryId])),
                ),
              ),
            )
            .returning({ id: cardBenefitAssignments.id })
        : await tx
            .insert(cardBenefitAssignments)
            .values({
              ownerId,
              entryId: values.entryId,
              accountId: account.id,
              catalogProductId: values.productId,
              creditId,
            })
            .onConflictDoUpdate({
              target: [
                cardBenefitAssignments.ownerId,
                cardBenefitAssignments.entryId,
                cardBenefitAssignments.catalogProductId,
              ],
              set: { creditId, updatedAt: new Date() },
              setWhere: sql`${cardBenefitAssignments.creditId} IS DISTINCT FROM ${creditId}`,
            })
            .returning({ id: cardBenefitAssignments.id });
    if (changed.length)
      await tx.insert(auditLogs).values({
        ownerId,
        actorUserId: ownerId,
        entityType: "journal_entry",
        entityId: values.entryId,
        action: values.mode === "credit" ? "benefit_assignment.set" : `benefit_assignment.${values.mode}`,
        changes: auditDetails.parse({
          entryId: values.entryId,
          accountId: account.id,
          catalogProductId: values.productId,
          creditId,
        }),
      });
    return values;
  });
}
