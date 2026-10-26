import { and, eq } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import { bankConnections, importJobs } from "@/db/schema";
import { syncConnection } from "./sync";
import { PlaidClient, plaidError } from "./plaid-client";
import { loadPlaidConfig } from "./config";
import type { BankClient, PlaidConfig } from "./types";
export async function processConfiguredBankJob(
  db: AppDb,
  job: typeof importJobs.$inferSelect,
  env: PlaidConfig,
  now = new Date(),
  makeClient: (config: PlaidConfig) => BankClient = (config) => new PlaidClient(config),
) {
  const { config } = await loadPlaidConfig(db, job.ownerId, env);
  const [connection] = job.connectionId
    ? await db
        .select({ environment: bankConnections.environment })
        .from(bankConnections)
        .where(and(eq(bankConnections.ownerId, job.ownerId), eq(bankConnections.id, job.connectionId)))
    : [];
  if (config.PLAID_ENABLED !== "true" || (connection && connection.environment !== config.PLAID_ENV)) {
    // Pause queued work without consuming retries while this owner's environment is disabled.
    await db
      .update(importJobs)
      .set({
        status: "queued",
        attempts: Math.max(0, job.attempts - 1),
        runAfter: new Date(now.getTime() + 60000),
        lockedAt: null,
        lockedBy: null,
      })
      .where(
        and(
          eq(importJobs.ownerId, job.ownerId),
          eq(importJobs.id, job.id),
          eq(importJobs.status, "running"),
          eq(importJobs.lockedBy, job.lockedBy ?? ""),
          eq(importJobs.attempts, job.attempts),
        ),
      );
    return;
  }
  return processBankJob(db, job, makeClient(config), config, now);
}
export async function processBankJob(
  db: AppDb,
  job: typeof importJobs.$inferSelect,
  client: BankClient,
  config: PlaidConfig,
  now = new Date(),
) {
  if (!job.connectionId || config.PLAID_ENABLED !== "true") return;
  const lease = and(
    eq(importJobs.ownerId, job.ownerId),
    eq(importJobs.id, job.id),
    eq(importJobs.status, "running"),
    eq(importJobs.lockedBy, job.lockedBy ?? ""),
    eq(importJobs.attempts, job.attempts),
  );
  try {
    const result = await syncConnection(db, job.ownerId, job.connectionId, client, config, now, job);
    await db
      .update(importJobs)
      .set(
        result.notReady || result.awaitingHistory
          ? {
              status: "queued",
              attempts: 0,
              runAfter: new Date(now.getTime() + 120000),
              lockedAt: null,
              lockedBy: null,
            }
          : { status: "succeeded", progress: 100, errorKind: null, lockedAt: null, lockedBy: null },
      )
      .where(lease);
  } catch (error) {
    const { errorCode, requestId } = plaidError(error);
    console.error(JSON.stringify({ error_code: errorCode, request_id: requestId }));
    const retry = job.attempts < 3 && !["ITEM_LOGIN_REQUIRED", "INVALID_ACCESS_TOKEN"].includes(errorCode);
    await db
      .update(importJobs)
      .set({
        status: retry ? "queued" : "failed",
        runAfter: new Date(now.getTime() + 30000 * 2 ** job.attempts),
        lockedAt: null,
        lockedBy: null,
        errorKind: errorCode,
      })
      .where(lease);
  }
}
