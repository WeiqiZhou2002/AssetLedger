import "./env";
import { parseArgs } from "node:util";
import { eq, sql } from "drizzle-orm";
import { getDb, getPool } from "@/db/client";
import { users } from "@/db/schema";
import { loadPlaidConfig } from "@/lib/bank-sync/config";
import { plaidError } from "@/lib/bank-sync/plaid-client";
import { fireSandboxWebhook, listSandboxWebhookConnections } from "@/lib/bank-sync/sandbox-webhook";
import { invariant, LedgerError } from "@/lib/ledger/errors";

async function main() {
  const { values } = parseArgs({
    options: {
      owner: { type: "string" },
      connection: { type: "string" },
      fire: { type: "boolean", default: false },
    },
  });
  invariant(values.owner, "需要 --owner");
  invariant(Boolean(values.connection) === values.fire, "需要同时指定 --connection 和 --fire");
  const pool = getPool();
  try {
    const db = getDb();
    const [owner] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(sql`lower(${users.email})`, values.owner.toLowerCase()));
    invariant(owner, "所有者不存在");
    const { config } = await loadPlaidConfig(db, owner.id);
    if (!values.fire) {
      const connections = await listSandboxWebhookConnections(db, owner.id, config);
      console.log(JSON.stringify({ connections }));
      return;
    }
    await fireSandboxWebhook(db, owner.id, values.connection!, config);
    console.log(JSON.stringify({ webhook_fired: true }));
    console.log("公网可达的 HTTPS 安装会实时收到提醒，刷新页面即可；HTTP 安装请点「立即同步」查询通知记录。");
  } finally {
    await pool.end();
  }
}
main().catch((error: unknown) => {
  // App-defined messages carry no secrets; Plaid errors are reduced to code and request id.
  if (error instanceof LedgerError) console.error(error.message);
  else {
    const safe = plaidError(error);
    console.error(JSON.stringify({ error_code: safe.errorCode, request_id: safe.requestId }));
  }
  process.exitCode = 1;
});
