import "../scripts/env";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { getDb, getPool } from "@/db/client";
import { readEnv } from "@/lib/env";
import { claimJob, failExpiredJobs, processJob } from "@/lib/imports/jobs";
import { retainFiles } from "@/lib/imports/evidence";
import { retainResetExports } from "@/lib/bank-sync/reset-files";
import { scheduleSyncs } from "@/lib/bank-sync/connections";
import { processBankJob } from "@/lib/bank-sync/jobs";
import { PlaidClient } from "@/lib/bank-sync/plaid-client";
async function main() {
  const env = readEnv();
  const stop = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => stop.abort());
  const pool = getPool();
  const db = getDb();
  const workerId = randomUUID();
  console.log(JSON.stringify({ kind: "worker_started", id: workerId }));
  let maintenanceAt = 0;
  try {
    while (!stop.signal.aborted) {
      try {
        if (Date.now() >= maintenanceAt) {
          await failExpiredJobs(db);
          await retainFiles(db, env);
          await retainResetExports(db, env);
          await scheduleSyncs(db, env);
          maintenanceAt = Date.now() + 60000;
        }
        const job = await claimJob(db, workerId, new Date(), env.PLAID_ENABLED === "true");
        if (job) {
          if (job.kind === "plaid_sync") await processBankJob(db, job, new PlaidClient(env), env);
          else await processJob(db, job, env);
          continue;
        }
      } catch {
        console.error(JSON.stringify({ kind: "worker_cycle_failed" }));
      }
      try {
        await setTimeout(2000, undefined, { signal: stop.signal });
      } catch {
        break;
      }
    }
  } finally {
    await pool.end();
    console.log(JSON.stringify({ kind: "worker_stopped", id: workerId }));
  }
}
main().catch(() => {
  console.error(JSON.stringify({ kind: "worker_failed" }));
  process.exitCode = 1;
});
