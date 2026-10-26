import "./env";
import { setTimeout } from "node:timers/promises";
import { getPool } from "@/db/client";
async function main() {
  const pool = getPool();
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await pool.query("select 1");
        return;
      } catch {
        await setTimeout(1000);
      }
    }
    throw new Error("db_unavailable");
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(JSON.stringify({ kind: "db_unavailable" }));
  process.exitCode = 1;
});
