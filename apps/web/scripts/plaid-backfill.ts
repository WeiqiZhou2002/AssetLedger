import "./env";
import { parseArgs } from "node:util";
import { eq, sql } from "drizzle-orm";
import { getDb, getPool } from "@/db/client";
import { users } from "@/db/schema";
import { loadPlaidConfig } from "@/lib/bank-sync/config";
import { affectedConnections, executeBackfill, planBackfill } from "@/lib/bank-sync/backfill";
import { invariant } from "@/lib/ledger/errors";
async function main() {
  const { values } = parseArgs({
    options: {
      owner: { type: "string" },
      connections: { type: "string" },
      from: { type: "string" },
      execute: { type: "boolean", default: false },
      recalculate: { type: "string" },
      exclude: { type: "string" },
    },
  });
  invariant(values.owner && values.connections, "需要 --owner 和 --connections");
  const db = getDb();
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.email})`, values.owner.toLowerCase()));
  invariant(owner, "所有者不存在");
  const { config } = await loadPlaidConfig(db, owner.id);
  const selected =
    values.connections === "affected"
      ? await affectedConnections(db, owner.id, config)
      : values.connections.split(",").map((connectionId) => ({ connectionId, reasons: ["显式选择"] }));
  const recalculate = values.recalculate?.split(",") ?? [];
  const exclude = values.exclude?.split(",") ?? [];
  // Preview every connection before executing any. Unknown action ids are rejected, never ignored.
  const plans: {
    connectionId: string;
    reasons: string[];
    plan: Awaited<ReturnType<typeof planBackfill>>;
    input: { from: string; actions: { accountId: string; action: string }[] };
  }[] = [];
  for (const selectedConnection of selected) {
    const base = await planBackfill(db, owner.id, selectedConnection.connectionId, config, {
      from: values.from,
    });
    const actions = base.accounts
      .filter((row) => recalculate.includes(row.accountId) || exclude.includes(row.accountId))
      .map((row) => ({
        accountId: row.accountId,
        action: exclude.includes(row.accountId) ? "exclude" : "recalculate",
      }));
    const input = { from: base.targetFromDate, actions };
    const plan = await planBackfill(db, owner.id, selectedConnection.connectionId, config, input);
    plans.push({ ...selectedConnection, plan, input });
  }
  invariant(
    [...recalculate, ...exclude].every((id) =>
      plans.some(({ plan }) => plan.accounts.some((row) => row.accountId === id)),
    ),
    "操作账户不在选择的连接中",
  );
  invariant(!recalculate.some((id) => exclude.includes(id)), "重算与排除不能同时选择");
  for (const { connectionId, reasons, plan, input } of plans) {
    // Deliberate operator output: dates, ids, counts only; no account names, amounts or credentials.
    console.log(
      JSON.stringify({
        mode: values.execute ? "execute" : "dry-run",
        reasons,
        connectionId,
        current: plan.currentFromDate,
        target: plan.targetFromDate,
        availabilityStart: plan.transactionsAvailable ? plan.availabilityStart : null,
        jobs: plan.jobs,
        accounts: plan.accounts.map(
          ({ accountId, enabled, action, openings, conflict, effectiveFromDate, entries, pending }) => ({
            accountId,
            enabled,
            action,
            openings,
            conflict,
            effectiveFromDate,
            entries,
            pending,
          }),
        ),
      }),
    );
    if (values.execute) await executeBackfill(db, owner.id, connectionId, config, input);
  }
}
main()
  .catch(() => {
    console.error("补导未完成：请核对所有者、连接环境/状态、日期范围及期初操作；默认仅预览。");
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPool().end();
  });
