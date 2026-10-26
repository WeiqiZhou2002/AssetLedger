import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { bankConnections, bankConnectionAccounts } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { verifyPassword } from "@/lib/auth/password";
import { invariant } from "@/lib/ledger/errors";
import { importLock } from "@/lib/imports/store";
import { token } from "./connections";
import { authorizeTransfer, transferCredentials } from "./transfer-auth";
import { encryptTransferBundle, transferPassphrase } from "./transfer-bundle";
import { auditConnectionTransfer } from "./transfer-audit";
import type { PlaidConfig } from "./types";
export async function exportConnections(
  db: AppDb,
  ownerId: string,
  config: PlaidConfig,
  input: unknown,
  ip: string,
  now = new Date(),
) {
  invariant(config.PLAID_ENABLED === "true", "银行连接未启用", 404);
  const data = transferCredentials
    .extend({
      passphrase: transferPassphrase,
      connectionIds: z.array(z.uuid()).min(1).max(25).optional(),
    })
    .strict()
    .parse(input);
  await authorizeTransfer(
    db,
    ownerId,
    data,
    { appSecret: config.APP_SECRET, ip },
    async (passwordHash) => {
      invariant(!(await verifyPassword(passwordHash, data.passphrase)), "迁移口令不能与登录密码相同");
    },
    () => now,
  );
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const rows = await tx
      .select()
      .from(bankConnections)
      .where(
        and(
          eq(bankConnections.ownerId, ownerId),
          eq(bankConnections.environment, config.PLAID_ENV),
          ne(bankConnections.status, "revoked"),
          data.connectionIds ? inArray(bankConnections.id, data.connectionIds) : undefined,
        ),
      );
    invariant(rows.length > 0, "没有可导出的银行连接");
    invariant(rows.length <= 25, "每次最多导出 25 个连接，请分批选择");
    const accounts = await tx
      .select()
      .from(bankConnectionAccounts)
      .where(
        and(
          eq(bankConnectionAccounts.ownerId, ownerId),
          inArray(
            bankConnectionAccounts.connectionId,
            rows.map((row) => row.id),
          ),
        ),
      );
    const bundle = await encryptTransferBundle(
      rows.map((row) => ({
        plaidItemId: row.plaidItemId,
        accessToken: token(row, config),
        environment: row.environment,
        institutionId: row.institutionId,
        institutionName: row.institutionName,
        products: row.products,
        autoPost: row.autoPost,
        importFromDate: row.importFromDate,
        daysRequested: row.daysRequested,
        accounts: accounts
          .filter((account) => account.connectionId === row.id)
          .map((account) => ({
            plaidAccountId: account.plaidAccountId,
            name: account.name,
            officialName: account.officialName,
            mask: account.mask,
            type: account.type,
            subtype: account.subtype,
            currency: account.currency,
          })),
      })),
      config.PLAID_ENV,
      data.passphrase,
      now,
    );
    await auditConnectionTransfer(tx, ownerId, "bank.connections_exported", {
      connectionIds: rows.map((row) => row.id),
      count: rows.length,
    });
    return bundle;
  });
}
