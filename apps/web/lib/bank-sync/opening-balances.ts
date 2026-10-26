import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "@/db/types";
import { bankConnections, bankConnectionAccounts } from "@/db/schema";
import { nonzeroAmount } from "@/lib/ledger/schemas";
import { invariant } from "@/lib/ledger/errors";
import { auditLedger } from "@/lib/ledger/audit";
import { importLock } from "@/lib/imports/store";
import { accountPositions, type AccountPosition } from "@/lib/ledger/observed-balances";
import { confirmObservedOpening } from "@/lib/ledger/opening-observation";
import { ownerSyncDate } from "./observations";
import type { PlaidConfig } from "./types";

type Connection = typeof bankConnections.$inferSelect;
type Mapping = typeof bankConnectionAccounts.$inferSelect;
export async function openingBalanceSuggestions(
  db: AppDb,
  ownerId: string,
  connections: Connection[],
  mappings: Mapping[],
  options: { includeExisting?: boolean; fromDate?: string } = {},
) {
  const eligible = mappings.filter(
    (row) =>
      row.accountId &&
      row.isEnabled &&
      connections.some(
        (connection) =>
          connection.id === row.connectionId && connection.lastSuccessAt && connection.status !== "revoked",
      ),
  );
  if (!eligible.length) return [];
  const positions = await accountPositions(
    db,
    ownerId,
    await ownerSyncDate(db, ownerId, new Date()),
    options,
  );
  return mappedOpeningSuggestions(connections, eligible, positions);
}
export function mappedOpeningSuggestions(
  connections: Connection[],
  mappings: Mapping[],
  positions: AccountPosition[],
) {
  return mappings
    .filter(
      (mapping) =>
        mapping.isEnabled &&
        connections.some(
          (connection) =>
            connection.id === mapping.connectionId &&
            connection.lastSuccessAt &&
            connection.status !== "revoked",
        ),
    )
    .flatMap((mapping) => {
      const suggestion = positions.find((row) => row.account.id === mapping.accountId)?.suggestion;
      return suggestion ? [{ ...suggestion, bankAccountId: mapping.id }] : [];
    });
}
export async function confirmOpeningBalance(
  db: AppDb,
  ownerId: string,
  connectionId: string,
  config: PlaidConfig,
  input: unknown,
) {
  const value = z.object({ bankAccountId: z.uuid(), amount: nonzeroAmount }).strict().parse(input);
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const [connection] = await tx
      .select()
      .from(bankConnections)
      .where(and(eq(bankConnections.ownerId, ownerId), eq(bankConnections.id, connectionId)));
    invariant(connection, "银行连接不存在", 404);
    invariant(connection.environment === config.PLAID_ENV && connection.status !== "revoked", "连接不可修改");
    const [mapping] = await tx
      .select()
      .from(bankConnectionAccounts)
      .where(
        and(
          eq(bankConnectionAccounts.ownerId, ownerId),
          eq(bankConnectionAccounts.connectionId, connectionId),
          eq(bankConnectionAccounts.id, value.bankAccountId),
        ),
      );
    invariant(mapping?.isEnabled && mapping.accountId, "请先启用账户映射", 404);
    const entry = await confirmObservedOpening(tx, ownerId, mapping.accountId, { amount: value.amount });
    await auditLedger(tx, ownerId, "bank_connection_account", mapping.id, "bank.opening_balance", {
      entryId: entry.id,
    });
    return entry;
  });
}
