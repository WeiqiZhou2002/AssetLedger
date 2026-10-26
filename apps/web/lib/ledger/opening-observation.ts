import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { accounts } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { accountPositions } from "./observed-balances";
import { nonzeroAmount } from "./schemas";
import { invariant } from "./errors";
import { importLock } from "@/lib/imports/store";
import { ownerSyncDate } from "@/lib/bank-sync/observations";
import { getEntry } from "./entries";
import { createQuickEntry } from "./builders";
import { auditLedger } from "./audit";
export async function confirmObservedOpening(db: AppDb, ownerId: string, accountId: string, input: unknown) {
  const value = z.object({ amount: nonzeroAmount }).strict().parse(input);
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const [account] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.ownerId, ownerId), eq(accounts.id, accountId)))
      .for("update");
    invariant(account && !account.isSystem && account.isActive, "账户不存在或未启用", 404);
    const position = (await accountPositions(tx, ownerId, await ownerSyncDate(tx, ownerId, new Date()))).find(
      (row) => row.account.id === accountId,
    )!;
    if (position.openingEntryId) return getEntry(tx, ownerId, position.openingEntryId);
    invariant(
      !position.pendingCount,
      `还有 ${position.pendingCount} 笔待审核流水，审核后再建立期初余额`,
      409,
    );
    invariant(position.suggestion, "请先录入或同步余额观察；证券市值不能用于建立账本成本");
    const entry = await createQuickEntry(tx, ownerId, {
      type: "opening_balance",
      toAccountId: accountId,
      amount: value.amount,
      eventDate: position.suggestion.eventDate,
      notes: "所有者核对余额观察及全部已确认流水后建立期初",
    });
    await auditLedger(tx, ownerId, "account", accountId, "account.observed_opening", {
      entryId: entry.id,
      snapshotId: position.observed!.snapshotId,
      itemId: position.observed!.itemId,
    });
    await auditLedger(tx, ownerId, "journal_entry", entry.id, "entry.observed_opening");
    return entry;
  });
}
