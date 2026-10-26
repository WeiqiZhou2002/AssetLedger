import { and, desc, eq, lte, or } from "drizzle-orm";
import {
  accounts,
  bankConnectionAccounts,
  bankConnections,
  balanceSnapshots,
  snapshotItems,
} from "@/db/schema";
import type { AppDb } from "@/db/types";
import { shiftDate } from "@/lib/bank-sync/date-range";
import { realTypes } from "./constants";
import { invariant } from "./errors";

export function balanceReminderDue(
  manual: boolean,
  days: number | null,
  latest: string | null,
  today: string,
) {
  return manual && days !== null && (latest === null || latest < shiftDate(today, -days));
}

async function enabledPlaidMappings(db: AppDb, ownerId: string) {
  return db
    .select({
      accountId: bankConnectionAccounts.accountId,
      securityAccountId: bankConnectionAccounts.securityAccountId,
      lastSyncedAt: bankConnections.lastSuccessAt,
    })
    .from(bankConnectionAccounts)
    .innerJoin(
      bankConnections,
      and(eq(bankConnections.id, bankConnectionAccounts.connectionId), eq(bankConnections.ownerId, ownerId)),
    )
    .where(and(eq(bankConnectionAccounts.ownerId, ownerId), eq(bankConnectionAccounts.isEnabled, true)));
}

export async function requireManualAccount(db: AppDb, ownerId: string, accountId: string) {
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.ownerId, ownerId), eq(accounts.id, accountId)));
  invariant(account, "账户不存在", 404);
  invariant(
    account.isActive && !account.isSystem && realTypes.includes(account.type),
    "仅启用的真实账户可以更新余额",
  );
  const [mapping] = await db
    .select({ id: bankConnectionAccounts.id })
    .from(bankConnectionAccounts)
    .where(
      and(
        eq(bankConnectionAccounts.ownerId, ownerId),
        eq(bankConnectionAccounts.isEnabled, true),
        or(
          eq(bankConnectionAccounts.accountId, accountId),
          eq(bankConnectionAccounts.securityAccountId, accountId),
        ),
      ),
    )
    .limit(1);
  invariant(!mapping, "Plaid 账户自动同步余额，不能手工更新");
  return account;
}

export async function accountBalanceTracking(db: AppDb, ownerId: string, today: string) {
  const [owned, mapped, observations] = await Promise.all([
    db
      .select()
      .from(accounts)
      .where(and(eq(accounts.ownerId, ownerId), eq(accounts.isSystem, false))),
    enabledPlaidMappings(db, ownerId),
    db
      .select({ accountId: snapshotItems.accountId, date: balanceSnapshots.snapshotDate })
      .from(snapshotItems)
      .innerJoin(
        balanceSnapshots,
        and(eq(balanceSnapshots.id, snapshotItems.snapshotId), eq(balanceSnapshots.ownerId, ownerId)),
      )
      .where(
        and(
          eq(snapshotItems.ownerId, ownerId),
          eq(snapshotItems.isCurrent, true),
          eq(balanceSnapshots.status, "published"),
          lte(balanceSnapshots.snapshotDate, today),
        ),
      )
      .orderBy(desc(balanceSnapshots.snapshotDate)),
  ]);
  const dates = new Map<string, string>();
  for (const observation of observations)
    if (observation.accountId && !dates.has(observation.accountId))
      dates.set(observation.accountId, observation.date);
  const sync = new Map<string, string | null>();
  for (const mapping of mapped)
    for (const id of [mapping.accountId, mapping.securityAccountId]) {
      if (id) sync.set(id, mapping.lastSyncedAt?.toISOString() ?? null);
    }
  return owned.map((account) => {
    const plaidSynced = sync.has(account.id);
    const manual = account.isActive && realTypes.includes(account.type) && !plaidSynced;
    const latestObservationDate = dates.get(account.id) ?? null;
    return {
      accountId: account.id,
      manual,
      plaidSynced,
      lastSyncedAt: sync.get(account.id) ?? null,
      balanceReminderDays: account.balanceReminderDays,
      latestObservationDate,
      reminderDue: balanceReminderDue(manual, account.balanceReminderDays, latestObservationDate, today),
    };
  });
}
export type BalanceTracking = Awaited<ReturnType<typeof accountBalanceTracking>>[number];
