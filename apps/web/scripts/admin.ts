import "./env";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import { getPool } from "@/db/client";
import * as schema from "@/db/schema";
import { readEnv } from "@/lib/env";
import { createAdmin } from "@/lib/auth/admin";
import { createSetupLink } from "@/lib/auth/setup";
async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((value) => value !== "--"),
    options: {
      email: { type: "string" },
      password: { type: "string" },
      "if-empty": { type: "boolean", default: false },
      status: { type: "boolean", default: false },
      "setup-link": { type: "boolean", default: false },
    },
  });
  if (values.status) {
    const pool = getPool();
    try {
      const result = await pool.query<{ has_users: boolean }>(
        "select exists(select 1 from users) as has_users",
      );
      console.log(JSON.stringify({ kind: "admin_status", hasUsers: result.rows[0].has_users }));
    } finally {
      await pool.end();
    }
    return;
  }
  if (values["setup-link"]) {
    const pool = getPool();
    try {
      // Explicit operator output only; never called by the application or entrypoint.
      console.log(JSON.stringify(await createSetupLink(drizzle(pool, { schema }))));
    } finally {
      await pool.end();
    }
    return;
  }
  const email = values.email ?? process.env.ADMIN_EMAIL;
  const password = values.password ?? process.env.ADMIN_PASSWORD;
  if (values["if-empty"] && (!email || !password)) return;
  if (!email || !password) throw new Error("需要邮箱和密码");
  const env = readEnv();
  const pool = getPool();
  try {
    const client = await pool.connect();
    try {
      await client.query("select pg_advisory_lock(9171024)");
      const user = await createAdmin(
        drizzle(client, { schema }),
        { email, password, baseCurrency: env.BASE_CURRENCY, timezone: env.TZ },
        values["if-empty"],
      );
      console.log(JSON.stringify({ kind: user ? "admin_created" : "admin_already_exists", id: user?.id }));
    } finally {
      await client.query("select pg_advisory_unlock(9171024)");
      client.release();
    }
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error("创建管理员失败：检查邮箱、至少 12 位的密码、环境配置及数据库连接。");
  process.exitCode = 1;
});
