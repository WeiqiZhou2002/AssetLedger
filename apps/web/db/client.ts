import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { readEnv } from "@/lib/env";
const globalDb = globalThis as unknown as { assetLedgerPool?: Pool };
export function getPool() {
  return (globalDb.assetLedgerPool ??= new Pool({
    connectionString: readEnv().DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  }));
}
export function getDb() {
  return drizzle(getPool(), { schema });
}
