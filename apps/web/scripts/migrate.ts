import "./env";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getPool } from "@/db/client";
async function main() {
  const pool = getPool();
  try {
    const client = await pool.connect();
    try {
      // Web and worker can start together; migrations must not race.
      await client.query("select pg_advisory_lock(9171023)");
      await migrate(drizzle(client), { migrationsFolder: "./db/migrations" });
      console.log(JSON.stringify({ kind: "migrations_complete" }));
    } finally {
      await client.query("select pg_advisory_unlock(9171023)");
      client.release();
    }
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(JSON.stringify({ kind: "migration_failed" }));
  process.exitCode = 1;
});
