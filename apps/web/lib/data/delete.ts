import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AppDb } from "@/db/types";
import { users, sessions, statements, bankConnections, accountCardSecrets } from "@/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import { consumeTotp } from "@/lib/auth/totp";
import { invariant } from "@/lib/ledger/errors";
import { importLock } from "@/lib/imports/store";
import { safeFile } from "@/lib/imports/files";
import { lockOwnerStructure } from "@/lib/snapshots/groups";
import { rewardsLock } from "@/lib/rewards/store";
import { ownerTables } from "./tables";
import { removeConnection } from "@/lib/bank-sync/connections";
import { PlaidClient, plaidError } from "@/lib/bank-sync/plaid-client";
import type { PlaidConfig, BankClient } from "@/lib/bank-sync/types";
export const DELETE_CONFIRMATION = "删除全部个人数据";
export async function deleteOwnerData(
  db: AppDb,
  ownerId: string,
  input: unknown,
  config: { DATA_DIR: string; APP_SECRET: string } & Partial<PlaidConfig>,
  now = new Date(),
  bankClient?: BankClient,
) {
  const values = z
    .object({
      confirmation: z.literal(DELETE_CONFIRMATION),
      password: z.string().min(1).max(1024),
      totpCode: z
        .string()
        .regex(/^\d{6}$/)
        .optional(),
    })
    .strict()
    .parse(input);
  await db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    await lockOwnerStructure(tx, ownerId);
    await rewardsLock(tx, ownerId);
    const [user] = await tx.select().from(users).where(eq(users.id, ownerId)).for("update");
    invariant(user && (await verifyPassword(user.passwordHash, values.password)), "密码或验证码不正确", 403);
    if (user.totpEnabledAt)
      invariant(
        values.totpCode && (await consumeTotp(tx, ownerId, values.totpCode, config.APP_SECRET, () => now)),
        "密码或验证码不正确；验证码不能重复使用",
        403,
      );
    const connections = await tx
      .select()
      .from(bankConnections)
      .where(and(eq(bankConnections.ownerId, ownerId), ne(bankConnections.status, "revoked")));
    if (connections.length) {
      invariant(
        config.PLAID_ENV && config.PLAID_SECRET && config.PLAID_CLIENT_ID,
        "删除数据前请配置对应环境的 Plaid 凭据以撤销连接",
      );
      invariant(
        connections.every((connection) => connection.environment === config.PLAID_ENV),
        "请在银行连接设置中切换到对应环境并逐一撤销连接，再删除全部数据",
      );
      const plaidConfig = { ...config, PLAID_ENABLED: "true" } as PlaidConfig;
      const client = bankClient ?? new PlaidClient(plaidConfig);
      for (const connection of connections) {
        try {
          await removeConnection(tx, ownerId, connection.id, client, plaidConfig);
        } catch (error) {
          // If a previous deletion attempt revoked this Item before a rollback, removal is already complete.
          if (plaidError(error).errorCode !== "INVALID_ACCESS_TOKEN") throw error;
        }
      }
    }
    const files = await tx.select().from(statements).where(eq(statements.ownerId, ownerId));
    // Shared content checks are internal only; never expose another owner's rows.
    for (const file of files.sort((a, b) => (a.fileSha256 ?? "").localeCompare(b.fileSha256 ?? ""))) {
      if (!file.fileSha256) continue;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`statement-file:${file.fileSha256}`}))`);
      const [other] = await tx
        .select({ id: statements.id })
        .from(statements)
        .where(
          and(
            ne(statements.ownerId, ownerId),
            eq(statements.fileSha256, file.fileSha256),
            sql`${statements.storagePath} IS NOT NULL`,
          ),
        )
        .limit(1);
      if (other) continue;
      invariant(/^[a-f0-9]{64}$/.test(file.fileSha256), "文件标识无效");
      if (file.storagePath) await rm(safeFile(config.DATA_DIR, file.storagePath), { force: true });
      await rm(join(resolve(config.DATA_DIR), "statements", file.fileSha256), {
        force: true,
        recursive: true,
      });
    }
    await rm(join(resolve(config.DATA_DIR), "resets", ownerId), { recursive: true, force: true });
    // Vault rows are deliberately absent from the export allowlist.
    await tx.delete(accountCardSecrets).where(eq(accountCardSecrets.ownerId, ownerId));
    for (const table of Object.values(ownerTables)) await tx.delete(table).where(eq(table.ownerId, ownerId));
    await tx.delete(sessions).where(eq(sessions.userId, ownerId));
  });
  console.info(JSON.stringify({ kind: "owner_data_deleted", ownerId }));
  return { ok: true };
}
