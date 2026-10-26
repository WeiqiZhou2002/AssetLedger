import { HttpError } from "@/lib/auth/http";
import { and, count, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { bankConnections, plaidSettings } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { encryptSecret } from "@/lib/auth/crypto";
import { readEnv } from "@/lib/env";
import { importLock } from "@/lib/imports/store";
import { auditLedger } from "@/lib/ledger/audit";
import { invariant } from "@/lib/ledger/errors";
import { loadPlaidConfig } from "./config";
import { plaidError, testPlaidCredentials } from "./plaid-client";
import type { PlaidConfig } from "./types";

const inputSchema = z
  .object({
    environment: z.enum(["sandbox", "production"]),
    clientId: z.string().trim().min(1).max(256),
    secret: z.string().trim().max(1024).optional(),
    redirectUri: z.string().trim().max(2048).default(""),
    enabled: z.boolean(),
    confirmEnvironmentChange: z.boolean().default(false),
  })
  .strict()
  .refine(
    ({ redirectUri, environment }) => {
      if (!redirectUri) return true;
      try {
        const url = new URL(redirectUri);
        return (
          !url.search &&
          !url.hash &&
          !url.username &&
          !url.password &&
          (url.protocol === "https:" ||
            (environment === "sandbox" && url.protocol === "http:" && url.hostname === "localhost"))
        );
      } catch {
        return false;
      }
    },
    { message: "OAuth 回跳地址无效", path: ["redirectUri"] },
  );

export async function publicPlaidSettings(db: AppDb, ownerId: string, env: PlaidConfig = readEnv()) {
  const { config, source } = await loadPlaidConfig(db, ownerId, env);
  const [row] =
    source === "settings"
      ? await db
          .select({ verifiedAt: plaidSettings.verifiedAt })
          .from(plaidSettings)
          .where(eq(plaidSettings.ownerId, ownerId))
      : [];
  return {
    source,
    environment: config.PLAID_ENV,
    clientId: config.PLAID_CLIENT_ID,
    hasSecret: Boolean(config.PLAID_SECRET),
    redirectUri: config.PLAID_REDIRECT_URI || null,
    enabled: config.PLAID_ENABLED === "true",
    verifiedAt: row?.verifiedAt?.toISOString() ?? null,
  };
}
export type PublicPlaidSettings = Awaited<ReturnType<typeof publicPlaidSettings>>;

export async function connectionEnvironments(db: AppDb, ownerId: string) {
  return db
    .select({ environment: bankConnections.environment, count: count() })
    .from(bankConnections)
    .where(and(eq(bankConnections.ownerId, ownerId), ne(bankConnections.status, "revoked")))
    .groupBy(bankConnections.environment);
}

export async function savePlaidSettings(
  db: AppDb,
  ownerId: string,
  input: unknown,
  env: PlaidConfig = readEnv(),
  test = false,
  verify: (config: PlaidConfig) => Promise<void> = testPlaidCredentials,
) {
  const values = inputSchema.parse(input);
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const { config, source } = await loadPlaidConfig(tx, ownerId, env);
    invariant(source !== "env", "Plaid 凭据由服务器环境变量管理", 409);
    const [old] = await tx.select().from(plaidSettings).where(eq(plaidSettings.ownerId, ownerId));
    const secret = values.secret || config.PLAID_SECRET;
    invariant(secret, "请填写 Secret");
    if (values.environment !== config.PLAID_ENV) {
      const others = (await connectionEnvironments(tx, ownerId)).some(
        (row) => row.environment !== values.environment,
      );
      invariant(
        !others || values.confirmEnvironmentChange,
        "切换环境后，另一环境的连接将停止同步。请确认后重试。",
        409,
      );
    }
    const same =
      config.PLAID_ENV === values.environment &&
      config.PLAID_CLIENT_ID === values.clientId &&
      config.PLAID_SECRET === secret;
    let verifiedAt = same ? (old?.verifiedAt ?? null) : null;
    if (test) {
      try {
        await verify({
          ...config,
          PLAID_ENV: values.environment,
          PLAID_CLIENT_ID: values.clientId,
          PLAID_SECRET: secret,
          PLAID_ENABLED: "true",
        });
      } catch (error) {
        const code = plaidError(error).errorCode;
        // Credential and environment problems are the owner's input, not an upstream outage.
        if (["INVALID_API_KEYS", "INVALID_FIELD"].includes(code))
          throw new HttpError(400, "Client ID 或 Secret 不正确，请核对 Plaid Dashboard 中所选环境的密钥");
        if (["INVALID_ENVIRONMENT", "UNAUTHORIZED_ENVIRONMENT"].includes(code))
          throw new HttpError(400, "凭据与所选环境不匹配或未获授权");
        throw new HttpError(
          502,
          code === "PLAID_REQUEST_FAILED"
            ? "无法连接 Plaid，请检查网络后重试"
            : `Plaid 凭据测试失败（错误码 ${code}），请稍后重试`,
        );
      }
      verifiedAt = new Date();
    }
    invariant(!values.enabled || verifiedAt, "启用前请先成功测试凭据");
    const saved = {
      environment: values.environment,
      clientId: values.clientId,
      secretEnc: encryptSecret(secret, env.APP_SECRET, "plaid-secret"),
      redirectUri: values.redirectUri || null,
      enabled: values.enabled,
      verifiedAt,
    };
    const [row] = await tx
      .insert(plaidSettings)
      .values({ ownerId, ...saved })
      .onConflictDoUpdate({
        target: plaidSettings.ownerId,
        set: saved,
      })
      .returning({ id: plaidSettings.id });
    await auditLedger(tx, ownerId, "plaid_settings", row.id, "plaid.settings.updated");
    if (test) await auditLedger(tx, ownerId, "plaid_settings", row.id, "plaid.settings.verified");
    return publicPlaidSettings(tx, ownerId, env);
  });
}
