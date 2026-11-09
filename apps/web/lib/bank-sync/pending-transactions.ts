import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  accounts,
  bankConnectionAccounts,
  bankConnections,
  importRows,
  plaidPendingTransactions as pending,
} from "@/db/schema";
import type { AppDb } from "@/db/types";
import type { EntryFilters } from "@/lib/ledger/schemas";
import { isCoreSweep } from "./core-sweeps";
import { effectiveFromDate } from "./date-range";
import { sanitized } from "./transaction-payload";
import type { BankTransaction, PlaidConfig, SyncPage } from "./types";

type Mapping = typeof bankConnectionAccounts.$inferSelect;
type Connection = typeof bankConnections.$inferSelect;
type PendingFilters = Pick<
  EntryFilters,
  "accountId" | "currency" | "merchant" | "from" | "to" | "minAmount" | "maxAmount"
>;

function eligibleMapping(account: Mapping | undefined, currency: string | null) {
  return Boolean(
    account &&
    account.type !== "loan" &&
    account.type !== "investment" &&
    account.isEnabled &&
    account.accountId &&
    !account.unsharedAt &&
    currency &&
    account.currency === currency,
  );
}

export function pendingInScope(
  transaction: BankTransaction,
  bankAccount: Mapping | undefined,
  connection: Pick<Connection, "importFromDate">,
) {
  return (
    eligibleMapping(bankAccount, transaction.currency) &&
    !isCoreSweep(
      `${transaction.name} ${transaction.originalDescription ?? ""} ${transaction.merchantName ?? ""}`,
    ) &&
    transaction.date >= effectiveFromDate(connection, bankAccount)
  );
}

export async function deletePendingForConnection(db: AppDb, ownerId: string, connectionId: string) {
  return db.delete(pending).where(and(eq(pending.ownerId, ownerId), eq(pending.connectionId, connectionId)));
}

export async function deletePendingForBankAccounts(
  db: AppDb,
  ownerId: string,
  connectionId: string,
  plaidAccountIds: string[],
) {
  if (!plaidAccountIds.length) return;
  await db
    .delete(pending)
    .where(
      and(
        eq(pending.ownerId, ownerId),
        eq(pending.connectionId, connectionId),
        inArray(pending.plaidAccountId, plaidAccountIds),
      ),
    );
}

// The caller holds the import lock and transaction for this connection's committed cursor.
export async function applyPendingTransactions(
  db: AppDb,
  ownerId: string,
  connection: Connection,
  batch: Omit<SyncPage, "hasMore">,
  mapped: Mapping[],
  now: Date,
) {
  const scope = and(eq(pending.ownerId, ownerId), eq(pending.connectionId, connection.id));
  const transactions = [...batch.added, ...batch.modified];
  const candidates = transactions.filter((row) => row.pending);
  const imported = candidates.length
    ? await db
        .select({ id: importRows.providerTransactionId })
        .from(importRows)
        .where(
          and(
            eq(importRows.ownerId, ownerId),
            eq(importRows.bankConnectionId, connection.id),
            inArray(
              importRows.providerTransactionId,
              candidates.map((row) => row.id),
            ),
          ),
        )
    : [];
  const importedIds = new Set(imported.map((row) => row.id));
  const mappings = new Map(
    mapped
      .filter((row) => row.ownerId === ownerId && row.connectionId === connection.id)
      .map((row) => [row.plaidAccountId, row]),
  );
  const retained = new Set<string>();
  let stored = 0;
  let removed = 0;
  const removeIds = async (ids: string[]) => {
    if (!ids.length) return;
    const deleted = await db
      .delete(pending)
      .where(and(scope, inArray(pending.providerTransactionId, ids)))
      .returning({ id: pending.id });
    removed += deleted.length;
  };
  for (const transaction of candidates) {
    if (importedIds.has(transaction.id)) continue;
    if (!pendingInScope(transaction, mappings.get(transaction.accountId), connection)) {
      retained.delete(transaction.id);
      await removeIds([transaction.id]);
      continue;
    }
    const payload = sanitized(transaction);
    const values = {
      plaidAccountId: payload.accountId,
      transactionDate: payload.transactionDate,
      amount: payload.amount,
      currency: transaction.currency!,
      merchant: payload.merchant,
      description: payload.description,
      updatedAt: now,
    };
    await db
      .insert(pending)
      .values({
        ownerId,
        connectionId: connection.id,
        providerTransactionId: transaction.id,
        createdAt: now,
        ...values,
      })
      .onConflictDoUpdate({
        target: [pending.ownerId, pending.connectionId, pending.providerTransactionId],
        set: values,
      });
    retained.add(transaction.id);
    stored++;
  }
  await removeIds(batch.removed);
  await removeIds(
    transactions.flatMap((row) =>
      !row.pending && row.pendingTransactionId ? [row.pendingTransactionId] : [],
    ),
  );
  if (connection.transactionsCursor === null) {
    const deleted = await db
      .delete(pending)
      .where(and(scope, retained.size ? notInArray(pending.providerTransactionId, [...retained]) : undefined))
      .returning({ id: pending.id });
    removed += deleted.length;
  }
  const remaining = await db
    .select({
      id: pending.providerTransactionId,
      accountId: pending.plaidAccountId,
      currency: pending.currency,
    })
    .from(pending)
    .where(scope);
  await removeIds(
    remaining
      .filter((row) => !eligibleMapping(mappings.get(row.accountId), row.currency))
      .map((row) => row.id),
  );
  return { stored, removed };
}

function eligiblePending(
  db: AppDb,
  ownerId: string,
  environment: PlaidConfig["PLAID_ENV"],
  filters: PendingFilters = {},
) {
  const search = filters.merchant ? `%${filters.merchant.replace(/[\\%_]/g, "\\$&")}%` : null;
  return db
    .select({
      id: pending.id,
      accountId: sql<string>`${accounts.id}`.as("account_id"),
      accountName: accounts.name,
      institutionName: bankConnections.institutionName,
      transactionDate: pending.transactionDate,
      amount: pending.amount,
      currency: pending.currency,
      merchant: pending.merchant,
      description: pending.description,
    })
    .from(pending)
    .innerJoin(
      bankConnections,
      and(
        eq(bankConnections.ownerId, ownerId),
        eq(bankConnections.id, pending.connectionId),
        eq(bankConnections.environment, environment),
        inArray(bankConnections.status, ["active", "consent_expiring"]),
      ),
    )
    .innerJoin(
      bankConnectionAccounts,
      and(
        eq(bankConnectionAccounts.ownerId, ownerId),
        eq(bankConnectionAccounts.connectionId, pending.connectionId),
        eq(bankConnectionAccounts.plaidAccountId, pending.plaidAccountId),
        eq(bankConnectionAccounts.isEnabled, true),
        isNotNull(bankConnectionAccounts.accountId),
        isNull(bankConnectionAccounts.unsharedAt),
        notInArray(bankConnectionAccounts.type, ["loan", "investment"]),
        eq(bankConnectionAccounts.currency, pending.currency),
      ),
    )
    .innerJoin(
      accounts,
      and(
        eq(accounts.ownerId, ownerId),
        eq(accounts.id, bankConnectionAccounts.accountId),
        eq(accounts.isActive, true),
        eq(accounts.isSystem, false),
        eq(accounts.currency, pending.currency),
      ),
    )
    .where(
      and(
        eq(pending.ownerId, ownerId),
        filters.accountId ? eq(accounts.id, filters.accountId) : undefined,
        filters.currency ? eq(pending.currency, filters.currency) : undefined,
        search ? or(ilike(pending.merchant, search), ilike(pending.description, search)) : undefined,
        filters.from ? gte(pending.transactionDate, filters.from) : undefined,
        filters.to ? lte(pending.transactionDate, filters.to) : undefined,
        filters.minAmount ? sql`abs(${pending.amount}) >= ${filters.minAmount}::numeric` : undefined,
        filters.maxAmount ? sql`abs(${pending.amount}) <= ${filters.maxAmount}::numeric` : undefined,
      ),
    );
}

export async function listPendingTransactions(
  db: AppDb,
  ownerId: string,
  environment: PlaidConfig["PLAID_ENV"],
  filters: PendingFilters = {},
) {
  const [rows, totals] = await Promise.all([
    eligiblePending(db, ownerId, environment, filters)
      .orderBy(desc(pending.transactionDate), desc(pending.createdAt), pending.id)
      .limit(200),
    db
      .select({ total: count() })
      .from(eligiblePending(db, ownerId, environment, filters).as("eligible_pending")),
  ]);
  return { total: totals[0].total, rows };
}

export type PendingTransactions = Awaited<ReturnType<typeof listPendingTransactions>>;

export async function pendingCountsByAccount(
  db: AppDb,
  ownerId: string,
  environment: PlaidConfig["PLAID_ENV"],
): Promise<Record<string, number>> {
  const eligible = eligiblePending(db, ownerId, environment).as("eligible_pending");
  const counts = await db
    .select({ accountId: eligible.accountId, total: count() })
    .from(eligible)
    .groupBy(eligible.accountId);
  return Object.fromEntries(counts.map((row) => [row.accountId, row.total]));
}

export function pendingSectionVisible(filters: EntryFilters) {
  return (
    !filters.offset &&
    (!filters.view || filters.view === "all" || filters.view === "cashflow") &&
    !filters.type &&
    !filters.categoryId &&
    !filters.status
  );
}
