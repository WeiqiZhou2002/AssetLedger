import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "@/db/types";
import { loyaltyAccounts, loyaltyEvents, loyaltyObservations } from "@/db/schema";
import { requireStatement } from "@/lib/imports/store";
import { invariant } from "@/lib/ledger/errors";
import { auditLedger } from "@/lib/ledger/audit";
import { dateSchema } from "@/lib/ledger/schemas";
import { pointsSchema } from "./schemas";
import { requireLoyaltyAccount, rewardsLock } from "./store";
const nonnegative = pointsSchema.refine((value) => /^\d+$/.test(value) && BigInt(value) >= 0n);
const statementRewardsSchema = z.object({ earned: nonnegative, total: nonnegative, as_of: dateSchema });
export async function statementRewardsPreview(db: AppDb, ownerId: string, statementId: string) {
  const statement = await requireStatement(db, ownerId, statementId);
  if (statement.status !== "approved" || statement.statementType !== "credit_card" || !statement.accountId)
    return null;
  const parsed = statementRewardsSchema.safeParse(statement.summary.rewards);
  if (!parsed.success) return null;
  const [linked, recorded] = await Promise.all([
    db
      .select()
      .from(loyaltyAccounts)
      .where(
        and(
          eq(loyaltyAccounts.ownerId, ownerId),
          eq(loyaltyAccounts.linkedCardAccountId, statement.accountId),
          eq(loyaltyAccounts.isActive, true),
        ),
      ),
    db
      .select()
      .from(loyaltyObservations)
      .where(and(eq(loyaltyObservations.ownerId, ownerId), eq(loyaltyObservations.statementId, statementId))),
  ]);
  return { ...parsed.data, accounts: linked, recorded: recorded[0] ?? null };
}
export async function confirmStatementRewards(
  db: AppDb,
  ownerId: string,
  statementId: string,
  input: unknown,
) {
  const { loyaltyAccountId } = z
    .object({ loyaltyAccountId: z.uuid(), confirmed: z.literal(true) })
    .strict()
    .parse(input);
  return db.transaction(async (tx) => {
    await rewardsLock(tx, ownerId);
    const preview = await statementRewardsPreview(tx, ownerId, statementId);
    invariant(preview, "账单尚未批准或没有完整的积分汇总");
    if (preview.recorded) {
      invariant(preview.recorded.loyaltyAccountId === loyaltyAccountId, "此账单已记录到另一个积分账户", 409);
      return preview.recorded;
    }
    const account = await requireLoyaltyAccount(tx, ownerId, loyaltyAccountId, true);
    invariant(
      preview.accounts.some((row) => row.id === account.id),
      "积分账户未关联这张信用卡",
    );
    if (BigInt(preview.earned) > 0n)
      await tx.insert(loyaltyEvents).values({
        ownerId,
        loyaltyAccountId,
        eventDate: preview.as_of,
        pointsDelta: BigInt(preview.earned),
        type: "earn",
        statementId,
        source: "statement",
        externalReference: `statement:${statementId}`,
      });
    const [observation] = await tx
      .insert(loyaltyObservations)
      .values({
        ownerId,
        loyaltyAccountId,
        observedOn: preview.as_of,
        balance: BigInt(preview.total),
        source: "statement",
        statementId,
      })
      .returning();
    await auditLedger(tx, ownerId, "statement", statementId, "loyalty.statement.confirm");
    return observation;
  });
}
