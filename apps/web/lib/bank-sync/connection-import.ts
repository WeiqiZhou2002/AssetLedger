import { and, eq } from "drizzle-orm";
import { bankConnections } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { encryptSecret } from "@/lib/auth/crypto";
import { invariant } from "@/lib/ledger/errors";
import { importLock } from "@/lib/imports/store";
import { mappingSuggestions, storeAccounts } from "./connections";
import { plaidError } from "./plaid-client";
import { authorizeTransfer, transferCredentials } from "./transfer-auth";
import { decryptTransferBundle, transferPassphrase, type TransferConnection } from "./transfer-bundle";
import { auditConnectionTransfer } from "./transfer-audit";
import type { BankClient, PlaidConfig } from "./types";

export type ConnectionImportResult = {
  institutionName: string;
  status: "imported" | "existing" | "failed";
  connectionId?: string;
  reason?: string;
};
async function existingItem(db: AppDb, ownerId: string, row: TransferConnection) {
  const [existing] = await db
    .select()
    .from(bankConnections)
    .where(
      and(
        eq(bankConnections.ownerId, ownerId),
        eq(bankConnections.environment, row.environment),
        eq(bankConnections.plaidItemId, row.plaidItemId),
      ),
    );
  return existing;
}
function existingResult(
  row: TransferConnection,
  existing: typeof bankConnections.$inferSelect,
): ConnectionImportResult {
  return existing.status === "revoked"
    ? { institutionName: row.institutionName, status: "failed", reason: "本实例已撤销此连接" }
    : { institutionName: existing.institutionName, status: "existing", connectionId: existing.id };
}
export async function importConnections(
  db: AppDb,
  ownerId: string,
  client: BankClient,
  config: PlaidConfig,
  file: string,
  input: unknown,
  ip: string,
  now = new Date(),
) {
  invariant(config.PLAID_ENABLED === "true", "银行连接未启用", 404);
  const data = transferCredentials.extend({ passphrase: transferPassphrase }).strict().parse(input);
  const bundle = await authorizeTransfer(
    db,
    ownerId,
    data,
    { appSecret: config.APP_SECRET, ip },
    async () => {
      const value = await decryptTransferBundle(file, data.passphrase);
      invariant(value.environment === config.PLAID_ENV, "连接文件所属环境与当前 Plaid 环境不同");
      return value;
    },
    () => now,
  );
  const checked: ({ row: TransferConnection } & (
    { result: ConnectionImportResult } | { verified: Awaited<ReturnType<BankClient["accounts"]>> }
  ))[] = [];
  for (const row of bundle.connections) {
    const existing = await existingItem(db, ownerId, row);
    if (existing) {
      checked.push({ row, result: existingResult(row, existing) });
      continue;
    }
    try {
      const verified = await client.accounts(row.accessToken);
      invariant(verified.item.id === row.plaidItemId, "Item 不匹配");
      checked.push({ row, verified });
    } catch (error) {
      checked.push({
        row,
        result: {
          institutionName: row.institutionName,
          status: "failed",
          reason:
            plaidError(error).errorCode === "ITEM_LOGIN_REQUIRED" ? "需要重新授权" : "令牌无效或 Item 已撤销",
        },
      });
    }
  }
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const results: ConnectionImportResult[] = [];
    for (const check of checked) {
      const { row } = check;
      // Recheck after taking the owner lock, including duplicates within this file.
      const existing = await existingItem(tx, ownerId, row);
      if (existing) {
        results.push(existingResult(row, existing));
        continue;
      }
      if ("result" in check) {
        results.push(check.result);
        continue;
      }
      const { verified } = check;
      const consent = verified.item.consentExpiresAt ? new Date(verified.item.consentExpiresAt) : null;
      const [connection] = await tx
        .insert(bankConnections)
        .values({
          ownerId,
          environment: config.PLAID_ENV,
          plaidItemId: verified.item.id,
          accessTokenEnc: encryptSecret(row.accessToken, config.APP_SECRET, "plaid-access-token"),
          institutionId: verified.item.institutionId,
          institutionName: verified.item.institutionName ?? row.institutionName,
          products: verified.item.products,
          autoPost: row.autoPost,
          importFromDate: row.importFromDate,
          daysRequested: row.daysRequested,
          consentExpiresAt: consent,
          status:
            consent && consent.getTime() <= now.getTime() + 7 * 86400000 ? "consent_expiring" : "active",
          transactionsCursor: null,
          mappingConfirmedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await storeAccounts(
        tx,
        ownerId,
        connection.id,
        verified.accounts.map((account) => {
          const hint = row.accounts.find((candidate) => candidate.plaidAccountId === account.id);
          return {
            ...account,
            officialName: account.officialName ?? hint?.officialName ?? null,
            // The provider determines membership, type, mask and currency; file metadata is only a naming hint.
            current: null,
            available: null,
            limit: null,
          };
        }),
        now,
      );
      // Exercise the same owner-scoped suggestion path used by newly linked banks.
      await mappingSuggestions(tx, ownerId, connection.id);
      results.push({
        institutionName: connection.institutionName,
        status: "imported",
        connectionId: connection.id,
      });
    }
    const imported = results.filter((row) => row.status === "imported");
    await auditConnectionTransfer(tx, ownerId, "bank.connections_imported", {
      connectionIds: imported.map((row) => row.connectionId!),
      count: imported.length,
      existingCount: results.filter((row) => row.status === "existing").length,
      failedCount: results.filter((row) => row.status === "failed").length,
    });
    return { results };
  });
}
