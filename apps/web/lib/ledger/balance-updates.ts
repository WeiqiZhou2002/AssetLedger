import { eq } from "drizzle-orm";
import { z } from "zod";
import { users } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { amountSchema } from "@/lib/money";
import { rateSchema } from "@/lib/money/fx";
import { createSnapshot, publishSnapshot } from "@/lib/snapshots/service";
import { lockOwnerStructure } from "@/lib/snapshots/groups";
import { importLock } from "@/lib/imports/store";
import { dateSchema } from "./schemas";
import { todayInTimezone } from "./format";
import { requireManualAccount } from "./balance-tracking";
import { invariant } from "./errors";
import { auditLedger } from "./audit";

const balanceUpdateSchema = z
  .object({
    amount: amountSchema,
    date: dateSchema,
    fx: z
      .object({ rate: rateSchema, observedOn: dateSchema, source: z.string().trim().min(1).max(200) })
      .strict()
      .optional(),
  })
  .strict();

export async function updateAccountBalance(
  db: AppDb,
  ownerId: string,
  accountId: string,
  input: unknown,
  now = new Date(),
) {
  const values = balanceUpdateSchema.parse(input);
  return db.transaction(async (tx) => {
    // Serialize mapping changes before taking the shared observation/account structure lock.
    await importLock(tx, ownerId);
    await lockOwnerStructure(tx, ownerId);
    const account = await requireManualAccount(tx, ownerId, accountId);
    const [owner] = await tx
      .select({ timezone: users.timezone, baseCurrency: users.baseCurrency })
      .from(users)
      .where(eq(users.id, ownerId));
    invariant(owner, "用户不存在", 404);
    invariant(values.date <= todayInTimezone(owner.timezone, now), "日期不能晚于今天");
    invariant(!values.fx || account.currency !== owner.baseCurrency, "基准币种无需汇率");
    const observation = await createSnapshot(tx, ownerId, {
      snapshotDate: values.date,
      label: account.type === "asset_security" ? "市值更新" : "余额更新",
      items: [{ accountId, balanceNative: values.amount, currency: account.currency }],
      fx: values.fx ? [{ ...values.fx, quoteCurrency: account.currency }] : [],
    });
    const published = await publishSnapshot(tx, ownerId, observation.id);
    await auditLedger(tx, ownerId, "account", accountId, "account.balance_update", {
      snapshotId: published.id,
    });
    return { id: published.id, accountId, date: published.snapshotDate };
  });
}
