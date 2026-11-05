import { and, eq } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import { bankConnections } from "@/db/schema";
import { importLock } from "@/lib/imports/store";
import { auditLedger } from "@/lib/ledger/audit";
import { requireConnection, type Connection } from "./connections";
import { plaidWebhookUrl } from "./webhook-url";
import type { BankClient, PlaidConfig } from "./types";

export async function registerWebhook(
  db: AppDb,
  connection: Connection,
  client: BankClient,
  config: PlaidConfig,
  accessToken: string,
) {
  const webhook = plaidWebhookUrl(config.APP_URL);
  if (connection.webhookUrl === webhook) return;
  try {
    await client.updateWebhook(accessToken, webhook);
    await db.transaction(async (tx) => {
      await importLock(tx, connection.ownerId);
      const current = await requireConnection(tx, connection.ownerId, connection.id);
      if (current.status === "revoked" || current.webhookUrl === webhook) return;
      await tx
        .update(bankConnections)
        .set({ webhookUrl: webhook })
        .where(and(eq(bankConnections.ownerId, connection.ownerId), eq(bankConnections.id, connection.id)));
      await auditLedger(tx, connection.ownerId, "bank_connection", connection.id, "bank.webhook_updated");
    });
  } catch {
    console.error(JSON.stringify({ kind: "plaid_webhook_update_failed", connectionId: connection.id }));
  }
}
