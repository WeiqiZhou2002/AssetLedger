import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { bankConnections } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { importLock } from "@/lib/imports/store";
import { auditLedger } from "@/lib/ledger/audit";
import { invariant } from "@/lib/ledger/errors";
import { requireConnection, token } from "./connections";
import { PlaidClient } from "./plaid-client";
import type { BankClient, PlaidConfig } from "./types";

export const sandboxOnlyMessage = "仅允许 Sandbox；未发出任何请求";
export const missingWebhookMessage = "先在应用中点「立即同步」登记通知地址，再触发";

export function listSandboxWebhookConnections(db: AppDb, ownerId: string, config: PlaidConfig) {
  // Select only the fields intended for operator output, never credentials or provider IDs.
  return db
    .select({
      id: bankConnections.id,
      institutionName: bankConnections.institutionName,
      status: bankConnections.status,
      webhookRegistered: sql<boolean>`${isNotNull(bankConnections.webhookUrl)}`,
      newAccountsPending: sql<boolean>`${isNotNull(bankConnections.newAccountsAvailableAt)}`,
    })
    .from(bankConnections)
    .where(and(eq(bankConnections.ownerId, ownerId), eq(bankConnections.environment, config.PLAID_ENV)))
    .orderBy(desc(bankConnections.createdAt), bankConnections.id);
}

export async function fireSandboxWebhook(
  db: AppDb,
  ownerId: string,
  connectionId: string,
  config: PlaidConfig,
  client?: Pick<BankClient, "sandboxFireWebhook">,
) {
  invariant(config.PLAID_ENABLED === "true" && config.PLAID_ENV === "sandbox", sandboxOnlyMessage);
  const connection = await requireConnection(db, ownerId, connectionId);
  invariant(connection.environment === "sandbox" && connection.status !== "revoked", sandboxOnlyMessage);
  invariant(connection.webhookUrl !== null, missingWebhookMessage);
  // Do not keep the owner lock open while waiting for Plaid.
  await (client ?? new PlaidClient(config)).sandboxFireWebhook(
    token(connection, config),
    "NEW_ACCOUNTS_AVAILABLE",
  );
  await db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const [current] = await tx
      .select({ status: bankConnections.status })
      .from(bankConnections)
      .where(and(eq(bankConnections.ownerId, ownerId), eq(bankConnections.id, connectionId)));
    if (!current || current.status === "revoked") return;
    await auditLedger(tx, ownerId, "bank_connection", connectionId, "bank.sandbox_webhook_fired");
  });
}
