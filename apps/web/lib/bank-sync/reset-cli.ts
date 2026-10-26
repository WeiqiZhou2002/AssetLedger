import { parseArgs } from "node:util";
import { eq, sql } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import { users } from "@/db/schema";
import { invariant } from "@/lib/ledger/errors";
import { executeReset, planReset } from "./reset";
import type { ResetConfig } from "./reset-types";

export async function runResetCli(db: AppDb, config: ResetConfig, args: string[], now = new Date()) {
  const { values } = parseArgs({
    args,
    options: {
      owner: { type: "string" },
      connections: { type: "string" },
      from: { type: "string" },
      "keep-openings": { type: "boolean", default: false },
      "delete-observations": { type: "boolean", default: false },
      execute: { type: "boolean", default: false },
    },
  });
  invariant(values.owner && values.connections, "需要 --owner 和 --connections（逗号分隔连接 ID 或 all）");
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.email})`, values.owner.toLowerCase()));
  invariant(owner, "所有者不存在");
  const input = {
    connections: values.connections === "all" ? "all" : values.connections.split(","),
    from: values.from,
    keepOpenings: values["keep-openings"],
    deleteObservations: values["delete-observations"],
  };
  const plan = await planReset(db, owner.id, config, input, now);
  const result = values.execute ? await executeReset(db, owner.id, config, input, now) : null;
  return { mode: values.execute ? "execute" : "dry-run", ...(result ?? plan) };
}
