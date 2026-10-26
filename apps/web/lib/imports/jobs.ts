import { and, eq, lt, lte, or, ne } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import { importJobs, statements } from "@/db/schema";
import { ImportFailure } from "./parser";
import { importLock } from "./store";
import { parseStatement, applyParsedOutcome } from "./processing";
import { callAi, applyAiRows, type AiConfig } from "./ai";
import type { ImportConfig } from "./service";
// This internal queue scan intentionally crosses owners; each claimed job supplies the owner
// for every subsequent domain query. No client can choose the worker's owner context.
export async function claimJob(db: AppDb, workerId: string, now = new Date(), plaidEnabled = false) {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(importJobs)
      .where(
        and(
          or(
            and(eq(importJobs.status, "queued"), lte(importJobs.runAfter, now)),
            and(eq(importJobs.status, "running"), lt(importJobs.lockedAt, new Date(now.getTime() - 600000))),
          ),
          lt(importJobs.attempts, 3),
          plaidEnabled ? undefined : ne(importJobs.kind, "plaid_sync"),
        ),
      )
      .orderBy(importJobs.runAfter, importJobs.id)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!job) return null;
    const [claimed] = await tx
      .update(importJobs)
      .set({ status: "running", attempts: job.attempts + 1, lockedAt: now, lockedBy: workerId, progress: 5 })
      .where(and(eq(importJobs.ownerId, job.ownerId), eq(importJobs.id, job.id)))
      .returning();
    if (job.statementId)
      await tx
        .update(statements)
        .set({ status: "parsing" })
        .where(and(eq(statements.ownerId, job.ownerId), eq(statements.id, job.statementId)));
    return claimed;
  });
}
export async function processJob(
  db: AppDb,
  job: typeof importJobs.$inferSelect,
  config: ImportConfig & AiConfig,
  now = new Date(),
) {
  if (!job.statementId) return;
  const statementId = job.statementId;
  try {
    const aiRows = job.kind === "ai_parse" ? await callAi(job.consent, config) : null;
    const parsed =
      job.kind === "pdf" || job.kind === "csv"
        ? await parseStatement(db, job.ownerId, statementId, config)
        : null;
    await db.transaction(async (tx) => {
      await importLock(tx, job.ownerId);
      const [current] = await tx
        .select()
        .from(importJobs)
        .where(and(eq(importJobs.ownerId, job.ownerId), eq(importJobs.id, job.id)))
        .for("update");
      if (
        !current ||
        current.status !== "running" ||
        current.lockedBy !== job.lockedBy ||
        current.attempts !== job.attempts
      )
        return;
      if (aiRows && job.consent) await applyAiRows(tx, job.ownerId, statementId, job.consent, aiRows);
      if (parsed) await applyParsedOutcome(tx, job.ownerId, statementId, parsed);
      await tx
        .update(importJobs)
        .set({ status: "succeeded", progress: 100, lockedAt: null, lockedBy: null, errorKind: null })
        .where(and(eq(importJobs.ownerId, job.ownerId), eq(importJobs.id, job.id)));
    });
  } catch (error) {
    const kind = error instanceof ImportFailure ? error.kind : "import_failed";
    await db.transaction(async (tx) => {
      const retry = job.attempts < 3;
      const [updated] = await tx
        .update(importJobs)
        .set({
          status: retry ? "queued" : "failed",
          runAfter: new Date(now.getTime() + 1000 * 2 ** job.attempts * 15),
          lockedAt: null,
          lockedBy: null,
          errorKind: kind,
        })
        .where(
          and(
            eq(importJobs.ownerId, job.ownerId),
            eq(importJobs.id, job.id),
            eq(importJobs.status, "running"),
            eq(importJobs.lockedBy, job.lockedBy ?? ""),
            eq(importJobs.attempts, job.attempts),
          ),
        )
        .returning();
      if (updated)
        await tx
          .update(statements)
          .set({ status: retry ? "queued" : "failed" })
          .where(and(eq(statements.ownerId, job.ownerId), eq(statements.id, statementId)));
    });
  }
}
export async function failExpiredJobs(db: AppDb, now = new Date()) {
  const expired = await db
    .select()
    .from(importJobs)
    .where(
      and(
        eq(importJobs.status, "running"),
        eq(importJobs.attempts, 3),
        lt(importJobs.lockedAt, new Date(now.getTime() - 600000)),
      ),
    );
  for (const job of expired)
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(importJobs)
        .set({ status: "failed", errorKind: "lease_expired", lockedAt: null, lockedBy: null })
        .where(
          and(
            eq(importJobs.ownerId, job.ownerId),
            eq(importJobs.id, job.id),
            eq(importJobs.status, "running"),
            lt(importJobs.lockedAt, new Date(now.getTime() - 600000)),
          ),
        )
        .returning();
      if (updated.length && job.statementId)
        await tx
          .update(statements)
          .set({ status: "failed" })
          .where(and(eq(statements.ownerId, job.ownerId), eq(statements.id, job.statementId)));
    });
}
