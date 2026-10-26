import { and, eq } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import { importJobs } from "@/db/schema";
import { syncConnection } from "./sync";
import { plaidError } from "./plaid-client";
import type { BankClient, PlaidConfig } from "./types";
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
