import { and, eq, ne } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import { bankConnections, bankConnectionAccounts } from "@/db/schema";
import { accountReminders, type ReminderConnection } from "./account-reminders";
import type { PlaidConfig } from "./types";

export type AccountReminderSummary = {
  id: string;
  institutionName: string;
  newAccountsAvailable: boolean;
  unmappedNewAccounts: number;
  unsharedMapped: number;
};

export async function accountReminderSummaries(
  db: AppDb,
  ownerId: string,
  environment: PlaidConfig["PLAID_ENV"],
): Promise<AccountReminderSummary[]> {
  const rows = await db
    .select({
      id: bankConnections.id,
      institutionName: bankConnections.institutionName,
      status: bankConnections.status,
      mappingConfirmedAt: bankConnections.mappingConfirmedAt,
      newAccountsAvailableAt: bankConnections.newAccountsAvailableAt,
      account: {
        id: bankConnectionAccounts.id,
        isEnabled: bankConnectionAccounts.isEnabled,
        accountId: bankConnectionAccounts.accountId,
        securityAccountId: bankConnectionAccounts.securityAccountId,
        unsharedAt: bankConnectionAccounts.unsharedAt,
        createdAt: bankConnectionAccounts.createdAt,
      },
    })
    .from(bankConnections)
    .leftJoin(
      bankConnectionAccounts,
      and(
        eq(bankConnectionAccounts.ownerId, ownerId),
        eq(bankConnectionAccounts.connectionId, bankConnections.id),
      ),
    )
    .where(
      and(
        eq(bankConnections.ownerId, ownerId),
        eq(bankConnections.environment, environment),
        ne(bankConnections.status, "revoked"),
      ),
    )
    .orderBy(bankConnections.institutionName, bankConnections.id);
  const connections = new Map<string, ReminderConnection & { id: string; institutionName: string }>();
  for (const row of rows) {
    const connection = connections.get(row.id) ?? { ...row, accounts: [] };
    if (row.account) connection.accounts.push(row.account);
    connections.set(row.id, connection);
  }
  return [...connections.values()].flatMap((connection) => {
    const { needsAttention, ...reminders } = accountReminders(connection);
    return needsAttention
      ? [{ id: connection.id, institutionName: connection.institutionName, ...reminders }]
      : [];
  });
}
