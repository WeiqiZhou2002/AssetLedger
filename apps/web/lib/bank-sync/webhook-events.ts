import { and, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { bankConnections } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { importLock } from "@/lib/imports/store";
import { auditLedger } from "@/lib/ledger/audit";
import { requireConnection } from "./connections";
import { plaidError } from "./plaid-client";
import type { BankClient, PlaidConfig } from "./types";

const pageSchema = z.object({
  events: z.array(
    z.object({
      itemId: z.string().nullable(),
      type: z.string(),
      code: z.string(),
      sentAt: z.iso.datetime({ offset: true }),
    }),
  ),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});
const retentionWindow = 7 * 86400000 - 10 * 60000;

export async function pollNewAccountEvents(
  db: AppDb,
  ownerId: string,
  connectionId: string,
  client: BankClient,
  config: PlaidConfig,
  now = new Date(),
) {
  if (config.PLAID_ENABLED !== "true") return;
  const log = (code: string) =>
    console.error(JSON.stringify({ kind: "plaid_webhook_events_failed", connectionId, code }));
  try {
    const connection = await requireConnection(db, ownerId, connectionId);
    if (connection.status === "revoked" || connection.environment !== config.PLAID_ENV) return;
    const handledAt = connection.newAccountsHandledAt?.getTime() ?? -Infinity;
    const startTime = new Date(Math.max(now.getTime() - retentionWindow, handledAt)).toISOString();
    let newestEvent: number | null = null;
    let cursor: string | undefined;
    const cursors = new Set<string>();
    try {
      for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
        const response = await client.webhookEvents({
          start_time: startTime,
          ...(cursor ? { cursor } : {}),
          count: 100,
          webhook_codes: ["NEW_ACCOUNTS_AVAILABLE"],
          item_ids: [connection.plaidItemId],
        });
        const parsed = pageSchema.safeParse(response);
        if (!parsed.success) {
          log("INVALID_RESPONSE");
          break;
        }
        const page = parsed.data;
        for (const event of page.events) {
          const sentAt = Date.parse(event.sentAt);
          if (
            event.itemId === connection.plaidItemId &&
            event.type === "ITEM" &&
            event.code === "NEW_ACCOUNTS_AVAILABLE" &&
            sentAt > handledAt
          ) {
            newestEvent = Math.max(newestEvent ?? -Infinity, sentAt);
          }
        }
        if (!page.hasMore) break;
        if (!page.nextCursor || cursors.has(page.nextCursor)) {
          log("CURSOR_NOT_ADVANCING");
          break;
        }
        if (pageNumber === 9) {
          log("PAGE_LIMIT_EXCEEDED");
          break;
        }
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
    } catch (error) {
      log(plaidError(error).errorCode);
    }
    if (newestEvent === null) return;
    await db.transaction(async (tx) => {
      await importLock(tx, ownerId);
      const current = await requireConnection(tx, ownerId, connectionId);
      // A dismissal or completed Link while the request was in flight takes precedence.
      if (newestEvent <= (current.newAccountsHandledAt?.getTime() ?? -Infinity)) return;
      const [updated] = await tx
        .update(bankConnections)
        .set({ newAccountsAvailableAt: now })
        .where(
          and(
            eq(bankConnections.ownerId, ownerId),
            eq(bankConnections.id, connectionId),
            ne(bankConnections.status, "revoked"),
            isNull(bankConnections.newAccountsAvailableAt),
          ),
        )
        .returning({ id: bankConnections.id });
      if (updated)
        await auditLedger(tx, ownerId, "bank_connection", updated.id, "bank.new_accounts_available");
    });
  } catch (error) {
    log(plaidError(error).errorCode);
  }
}
