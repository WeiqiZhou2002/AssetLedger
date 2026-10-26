import { getDb } from "@/db/client";
import { readEnv } from "@/lib/env";
import { healthStatus } from "@/lib/health";
import { sql } from "drizzle-orm";
export async function GET() {
  const health = await healthStatus(() => getDb().execute(sql`select 1`), readEnv().PARSER_URL);
  return Response.json(health, {
    status: health.db === "error" ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
