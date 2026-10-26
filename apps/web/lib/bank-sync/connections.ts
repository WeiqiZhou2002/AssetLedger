import { and, desc, eq, inArray, sql, ne } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "@/db/types";
import {
  bankConnections,
  bankConnectionAccounts,
  accounts,
  balanceSnapshots,
  bankSyncRuns,
  importJobs,
} from "@/db/schema";
import { encryptSecret, decryptSecret, privateHash } from "@/lib/auth/crypto";
import { auditLedger } from "@/lib/ledger/audit";
import { invariant } from "@/lib/ledger/errors";
import { dateSchema } from "@/lib/ledger/schemas";
import { importLock } from "@/lib/imports/store";
import { ownerSyncDate } from "./observations";
import { historyStart, historyDaysRequested, backfillDefault, availabilityStart } from "./date-range";
import { accountPositions } from "@/lib/ledger/observed-balances";
import { mappedOpeningSuggestions } from "./opening-balances";
import { importedAccountSchema, plaidLedgerType } from "@/lib/imports/account-defaults";
import { createImportedAccount } from "@/lib/imports/account-creation";
import { plaidError } from "./plaid-client";
import type { BankAccount, BankClient, LinkRequest, PlaidConfig } from "./types";
export type Connection = typeof bankConnections.$inferSelect;
function publicConnection(row: Connection) {
  const { accessTokenEnc: _secret, transactionsCursor: _cursor, backfillPlan: _plan, ...safe } = row;
  void _secret;
  void _cursor;
  return { ...safe, backfillPending: Boolean(_plan) };
}
export function token(row: Connection, config: PlaidConfig) {
  invariant(row.environment === config.PLAID_ENV, "连接所属环境与当前配置不同");
  return decryptSecret(row.accessTokenEnc, config.APP_SECRET, "plaid-access-token");
}
export async function requireConnection(db: AppDb, ownerId: string, id: string) {
  const [row] = await db
    .select()
    .from(bankConnections)
    .where(and(eq(bankConnections.ownerId, ownerId), eq(bankConnections.id, id)));
  invariant(row, "银行连接不存在", 404);
  return row;
}
export async function connectionAccounts(db: AppDb, ownerId: string, id: string) {
  await requireConnection(db, ownerId, id);
  return db
    .select()
    .from(bankConnectionAccounts)
    .where(and(eq(bankConnectionAccounts.ownerId, ownerId), eq(bankConnectionAccounts.connectionId, id)));
}
export async function listConnections(db: AppDb, ownerId: string, config?: PlaidConfig) {
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const rows = await tx
      .select()
      .from(bankConnections)
      .where(eq(bankConnections.ownerId, ownerId))
      .orderBy(desc(bankConnections.createdAt));
    const mapped = await tx
      .select()
      .from(bankConnectionAccounts)
      .where(eq(bankConnectionAccounts.ownerId, ownerId));
    const runs = await tx
      .select()
      .from(bankSyncRuns)
      .where(eq(bankSyncRuns.ownerId, ownerId))
      .orderBy(desc(bankSyncRuns.startedAt), desc(bankSyncRuns.createdAt));
    const [complete] = await tx
      .select({ date: balanceSnapshots.snapshotDate })
      .from(balanceSnapshots)
      .where(
        and(
          eq(balanceSnapshots.ownerId, ownerId),
          eq(balanceSnapshots.status, "published"),
          eq(balanceSnapshots.isComplete, true),
          ne(balanceSnapshots.source, "plaid"),
        ),
      )
      .orderBy(desc(balanceSnapshots.snapshotDate))
      .limit(1);
    const positions = await accountPositions(tx, ownerId, await ownerSyncDate(tx, ownerId, new Date()));
    const openings = mappedOpeningSuggestions(rows, mapped, positions);
    return Promise.all(
      rows.map(async (row) => ({
        ...publicConnection(row),
        availabilityStart: availabilityStart(
          await ownerSyncDate(tx, ownerId, row.createdAt),
          row.daysRequested,
        ),
        defaultBackfillFrom: config
          ? backfillDefault(config, await ownerSyncDate(tx, ownerId, new Date()), row.importFromDate)
          : row.importFromDate,
        latestRun: runs.find((run) => run.connectionId === row.id) ?? null,
        completeSnapshotDate: complete?.date ?? null,
        accounts: mapped
          .filter((account) => account.connectionId === row.id)
          .map((account) => ({
            ...account,
            openingPendingCount:
              positions.find((position) => position.account.id === account.accountId)?.pendingCount ?? 0,
            openingSuggestion: openings.find((suggestion) => suggestion.bankAccountId === account.id) ?? null,
          })),
      })),
    );
  });
}

export async function createLinkToken(
  db: AppDb,
  ownerId: string,
  client: BankClient,
  config: PlaidConfig,
  product: "transactions" | "investments",
  connectionId?: string,
  now = new Date(),
) {
  invariant(config.PLAID_ENABLED === "true", "银行连接未启用", 404);
  const request: LinkRequest = {
    user: { client_user_id: privateHash(`plaid:${ownerId}`, config.APP_SECRET) },
    client_name: "Asset Ledger",
    country_codes: ["US"],
    language: "en",
    ...(config.PLAID_REDIRECT_URI ? { redirect_uri: config.PLAID_REDIRECT_URI } : {}),
  };
  if (connectionId) {
    const connection = await requireConnection(db, ownerId, connectionId);
    invariant(connection.status !== "revoked", "已删除的连接不能重新授权");
    request.access_token = token(connection, config);
  } else {
    const created = (await listConnections(db, ownerId)).filter(
      (row) => row.environment === "production",
    ).length;
    invariant(config.PLAID_ENV !== "production" || created < 10, "Trial 已创建 10 个连接，删除不会返还名额");
    const today = await ownerSyncDate(db, ownerId, now);
    invariant(historyStart(config, today) <= today, "历史起点不能晚于本地今天");
    request.products = [product];
    if (product === "transactions")
      request.transactions = {
        days_requested: historyDaysRequested(config, today),
      };
  }
  return client.linkToken(request);
}
export async function storeAccounts(
  db: AppDb,
  ownerId: string,
  connectionId: string,
  rows: BankAccount[],
  now: Date,
) {
  for (const row of rows) {
    const values = {
      name: row.name,
      officialName: row.officialName,
      mask: row.mask,
      type: row.type,
      subtype: row.subtype,
      currency: row.currency,
      lastBalanceCurrent: row.current,
      lastBalanceAvailable: row.available,
      lastBalanceLimit: row.limit,
      lastBalanceAt: now,
    };
    await db
      .insert(bankConnectionAccounts)
      .values({ ownerId, connectionId, plaidAccountId: row.id, ...values })
      .onConflictDoUpdate({
        target: [bankConnectionAccounts.connectionId, bankConnectionAccounts.plaidAccountId],
        set: values,
      });
  }
}
export async function mappingSuggestions(db: AppDb, ownerId: string, id: string) {
  const [bank, ledger, mapped] = await Promise.all([
    connectionAccounts(db, ownerId, id),
    db
      .select()
      .from(accounts)
      .where(and(eq(accounts.ownerId, ownerId), eq(accounts.isActive, true), eq(accounts.isSystem, false))),
    db.select().from(bankConnectionAccounts).where(eq(bankConnectionAccounts.ownerId, ownerId)),
  ]);
  return bank.map((row) => ({
    ...row,
    suggestions: ledger
      .filter(
        (account) =>
          row.mask &&
          account.last4 === row.mask &&
          compatibleMapping(row, account, account.type === "asset_security") &&
          !mapped.some(
            (other) =>
              other.id !== row.id &&
              (other.accountId === account.id || other.securityAccountId === account.id),
          ),
      )
      .map((account) => ({ id: account.id, name: account.name, type: account.type })),
  }));
}
function compatibleMapping(
  bank: { type: string; currency: string | null },
  ledger: { type: string; currency: string },
  security = false,
) {
  return (
    bank.currency === ledger.currency &&
    (security
      ? bank.type === "investment" && ledger.type === "asset_security"
      : plaidLedgerType(bank.type) === ledger.type)
  );
}
export async function exchangeConnection(
  db: AppDb,
  ownerId: string,
  client: BankClient,
  config: PlaidConfig,
  input: unknown,
  now = new Date(),
) {
  const data = z
    .object({
      public_token: z.string().min(1).max(1000),
      institution: z.object({
        institution_id: z.string().max(200).nullable(),
        name: z.string().min(1).max(200),
      }),
    })
    .strict()
    .parse(input);
  const today = await ownerSyncDate(db, ownerId, now);
  const importFromDate = historyStart(config, today);
  invariant(importFromDate <= today, "历史起点不能晚于本地今天");
  const exchanged = await client.exchange(data.public_token);
  // Persist the encrypted credential before a subsequent network request can fail, so the Item is recoverable/removable.
  const connection = await db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const [row] = await tx
      .insert(bankConnections)
      .values({
        ownerId,
        environment: config.PLAID_ENV,
        plaidItemId: exchanged.itemId,
        institutionId: data.institution.institution_id,
        institutionName: data.institution.name,
        accessTokenEnc: encryptSecret(exchanged.accessToken, config.APP_SECRET, "plaid-access-token"),
        importFromDate,
        daysRequested: historyDaysRequested(config, today),
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning();
    const [existing] = row
      ? [row]
      : await tx
          .select()
          .from(bankConnections)
          .where(
            and(
              eq(bankConnections.ownerId, ownerId),
              eq(bankConnections.environment, config.PLAID_ENV),
              eq(bankConnections.plaidItemId, exchanged.itemId),
            ),
          );
    await auditLedger(tx, ownerId, "bank_connection", existing.id, "bank.exchange");
    return existing;
  });
  await refreshConnection(db, ownerId, connection.id, client, config, now);
  return {
    connection: publicConnection(await requireConnection(db, ownerId, connection.id)),
    accounts: await mappingSuggestions(db, ownerId, connection.id),
  };
}
export async function refreshConnection(
  db: AppDb,
  ownerId: string,
  id: string,
  client: BankClient,
  config: PlaidConfig,
  now = new Date(),
) {
  const connection = await requireConnection(db, ownerId, id);
  invariant(connection.status !== "revoked", "连接已删除");
  let result;
  try {
    result = await client.accounts(token(connection, config));
  } catch (error) {
    await recordConnectionFailure(db, ownerId, id, error, now);
    throw error;
  }
  invariant(result.item.id === connection.plaidItemId, "Plaid Item 不匹配");
  const consent = result.item.consentExpiresAt ? new Date(result.item.consentExpiresAt) : null;
  await db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const current = await requireConnection(tx, ownerId, id);
    invariant(current.status !== "revoked", "连接已删除");
    await storeAccounts(tx, ownerId, id, result.accounts, now);
    await tx
      .update(bankConnections)
      .set({
        institutionId: result.item.institutionId,
        institutionName: result.item.institutionName ?? connection.institutionName,
        products: result.item.products,
        consentExpiresAt: consent,
        status: consent && consent.getTime() <= now.getTime() + 7 * 86400000 ? "consent_expiring" : "active",
        errorCode: null,
      })
      .where(and(eq(bankConnections.ownerId, ownerId), eq(bankConnections.id, id)));
  });
  return publicConnection(await requireConnection(db, ownerId, id));
}
export async function queueSync(
  db: AppDb,
  ownerId: string,
  id: string,
  config: PlaidConfig,
  manual = true,
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const row = await requireConnection(tx, ownerId, id);
    invariant(
      row.environment === config.PLAID_ENV &&
        ["active", "consent_expiring"].includes(row.status) &&
        row.mappingConfirmedAt,
      "请先完成账户映射或重新授权",
    );
    invariant(
      !manual || !row.lastRequestedAt || now.getTime() - row.lastRequestedAt.getTime() >= 60000,
      "每个连接每分钟最多请求一次同步",
      409,
    );
    const [job] = await tx
      .insert(importJobs)
      .values({
        ownerId,
        connectionId: id,
        kind: "plaid_sync",
        syncGeneration: row.syncGeneration,
        runAfter: now,
      })
      .onConflictDoNothing()
      .returning();
    if (manual)
      await tx
        .update(bankConnections)
        .set({ lastRequestedAt: now })
        .where(and(eq(bankConnections.ownerId, ownerId), eq(bankConnections.id, id)));
    return { queued: Boolean(job) };
  });
}
export async function saveMapping(
  db: AppDb,
  ownerId: string,
  id: string,
  config: PlaidConfig,
  input: unknown,
  now = new Date(),
) {
  const values = z
    .object({
      importFromDate: dateSchema,
      accounts: z
        .array(
          z.union([
            z
              .object({
                id: z.uuid(),
                accountId: z.uuid().nullable(),
                securityAccountId: z.uuid().nullable().default(null),
                isEnabled: z.boolean().default(true),
              })
              .strict(),
            z
              .object({
                id: z.uuid(),
                create: importedAccountSchema,
                isEnabled: z.boolean().default(true),
              })
              .strict(),
          ]),
        )
        .max(100),
    })
    .strict()
    .parse(input);
  await db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const connection = await requireConnection(tx, ownerId, id);
    invariant(connection.environment === config.PLAID_ENV && connection.status !== "revoked", "连接不可修改");
    invariant(
      !connection.lastSuccessAt || connection.importFromDate === values.importFromDate,
      "首次同步后导入起始日期已固定",
    );
    const own = await connectionAccounts(tx, ownerId, id);
    const all = await tx
      .select()
      .from(bankConnectionAccounts)
      .where(eq(bankConnectionAccounts.ownerId, ownerId));
    const ledger = await tx.select().from(accounts).where(eq(accounts.ownerId, ownerId));
    invariant(new Set(values.accounts.map((row) => row.id)).size === values.accounts.length, "账户映射重复");
    let replay = false;
    const used = new Set(
      all
        .filter((row) => row.connectionId !== id || !values.accounts.some((v) => v.id === row.id))
        .flatMap((row) => [row.accountId, row.securityAccountId].filter(Boolean)),
    );
    for (const value of values.accounts) {
      const bank = own.find((row) => row.id === value.id);
      invariant(bank, "连接账户不存在", 404);
      const creating = "create" in value;
      let accountId = "accountId" in value ? value.accountId : null;
      let securityAccountId = "securityAccountId" in value ? value.securityAccountId : null;
      invariant(
        !connection.mappingConfirmedAt ||
          !bank.accountId ||
          (!creating && bank.accountId === accountId && bank.securityAccountId === securityAccountId),
        "已确认映射不能改绑，请停用后创建新的账本账户连接",
      );
      if ("create" in value) {
        invariant(compatibleMapping(bank, value.create), "账户类型或币种不兼容");
        const institution = {
          name: connection.institutionName,
          plaidInstitutionId: connection.institutionId,
        };
        const created = await createImportedAccount(
          tx,
          ownerId,
          {
            ...value.create,
            last4:
              value.create.last4 === undefined
                ? bank.mask && /^\d{4}$/.test(bank.mask)
                  ? bank.mask
                  : null
                : value.create.last4,
          },
          institution,
        );
        ledger.push(created);
        accountId = created.id;
        if (bank.type === "investment") {
          const security = await createImportedAccount(
            tx,
            ownerId,
            {
              name: `${created.name.slice(0, 97)} 持仓`,
              type: "asset_security",
              currency: created.currency,
              last4: created.last4,
              cashLikeInclusion: false,
              financialInclusion: created.financialInclusion,
            },
            institution,
          );
          ledger.push(security);
          securityAccountId = security.id;
        }
      }
      if (value.isEnabled && !bank.isEnabled) replay = true;
      invariant(!value.isEnabled || accountId, "启用前请选择对应账户");
      invariant(
        !value.isEnabled || bank.type !== "investment" || securityAccountId,
        "投资账户需要同时映射现金和证券账户",
      );
      for (const [ledgerAccountId, security] of [
        [accountId, false],
        [securityAccountId, true],
      ] as const) {
        if (!ledgerAccountId) continue;
        const account = ledger.find((row) => row.id === ledgerAccountId);
        invariant(
          account && account.isActive && !account.isSystem && compatibleMapping(bank, account, security),
          "账户类型或币种不兼容",
        );
        invariant(!used.has(ledgerAccountId), "该账本账户已映射到其他 Plaid 账户");
        used.add(ledgerAccountId);
      }
      await tx
        .update(bankConnectionAccounts)
        .set({
          accountId,
          securityAccountId,
          accountCreatedHere: creating || bank.accountCreatedHere,
          isEnabled: value.isEnabled,
        })
        .where(and(eq(bankConnectionAccounts.ownerId, ownerId), eq(bankConnectionAccounts.id, value.id)));
      await auditLedger(tx, ownerId, "bank_connection_account", value.id, "bank.account_mapping", {
        accountId,
        securityAccountId,
        createdHere: creating,
      });
    }
    await tx
      .update(bankConnections)
      .set({
        importFromDate: values.importFromDate,
        mappingConfirmedAt: now,
        ...(replay ? { transactionsCursor: null } : {}),
      })
      .where(and(eq(bankConnections.ownerId, ownerId), eq(bankConnections.id, id)));
    await auditLedger(tx, ownerId, "bank_connection", id, "bank.mapping");
    await queueSync(tx, ownerId, id, config, false, now);
  });
  return publicConnection(await requireConnection(db, ownerId, id));
}
export async function removeConnection(
  db: AppDb,
  ownerId: string,
  id: string,
  client: BankClient,
  config: PlaidConfig,
) {
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const connection = await requireConnection(tx, ownerId, id);
    if (connection.status === "revoked") return publicConnection(connection);
    try {
      await client.remove(token(connection, config));
    } catch (error) {
      if (plaidError(error).errorCode !== "INVALID_ACCESS_TOKEN") throw error;
    }
    const [row] = await tx
      .update(bankConnections)
      .set({ status: "revoked", accessTokenEnc: "", errorCode: null })
      .where(and(eq(bankConnections.ownerId, ownerId), eq(bankConnections.id, id)))
      .returning();
    await tx
      .update(bankConnectionAccounts)
      .set({ isEnabled: false })
      .where(and(eq(bankConnectionAccounts.ownerId, ownerId), eq(bankConnectionAccounts.connectionId, id)));
    await tx
      .update(importJobs)
      .set({ status: "failed", errorKind: "connection_revoked", lockedAt: null, lockedBy: null })
      .where(
        and(
          eq(importJobs.ownerId, ownerId),
          eq(importJobs.connectionId, id),
          inArray(importJobs.status, ["queued", "running"]),
        ),
      );
    await auditLedger(tx, ownerId, "bank_connection", id, "bank.remove");
    return publicConnection(row);
  });
}
export async function scheduleSyncs(db: AppDb, config: PlaidConfig, now = new Date()) {
  if (config.PLAID_ENABLED !== "true") return;
  // Internal scheduler crosses owners; all work below uses the persisted owner's identity.
  const rows = await db
    .select()
    .from(bankConnections)
    .where(
      and(
        eq(bankConnections.environment, config.PLAID_ENV),
        inArray(bankConnections.status, ["active", "consent_expiring"]),
        sql`${bankConnections.mappingConfirmedAt} IS NOT NULL`,
      ),
    );
  for (const row of rows) {
    if (
      row.lastSyncedAt &&
      now.getTime() - row.lastSyncedAt.getTime() < config.PLAID_SYNC_INTERVAL_HOURS * 3600000
    )
      continue;
    await queueSync(db, row.ownerId, row.id, config, false, now);
  }
}

export async function recordConnectionFailure(
  db: AppDb,
  ownerId: string,
  id: string,
  error: unknown,
  now = new Date(),
  generation?: number,
) {
  const safe = plaidError(error);
  await db
    .update(bankConnections)
    .set({
      lastSyncedAt: now,
      errorCode: safe.errorCode,
      ...(safe.errorCode === "ITEM_LOGIN_REQUIRED"
        ? { status: "login_required" as const }
        : safe.errorCode === "INVALID_ACCESS_TOKEN"
          ? { status: "error" as const }
          : {}),
    })
    .where(
      and(
        eq(bankConnections.ownerId, ownerId),
        eq(bankConnections.id, id),
        ne(bankConnections.status, "revoked"),
        generation === undefined ? undefined : eq(bankConnections.syncGeneration, generation),
      ),
    );
}
