import { eq } from "drizzle-orm";
import { plaidSettings } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { decryptSecret } from "@/lib/auth/crypto";
import { readEnv } from "@/lib/env";
import type { PlaidConfig } from "./types";

type Resolved<T> = { config: T; source: "env" | "settings" | "none" };
export function loadPlaidConfig(db: AppDb, ownerId: string): Promise<Resolved<ReturnType<typeof readEnv>>>;
export function loadPlaidConfig<T extends PlaidConfig>(
  db: AppDb,
  ownerId: string,
  env: T,
): Promise<Resolved<Omit<T, keyof PlaidConfig> & PlaidConfig>>;
export async function loadPlaidConfig(
  db: AppDb,
  ownerId: string,
  env: PlaidConfig = readEnv(),
): Promise<Resolved<PlaidConfig>> {
  if (env.PLAID_CLIENT_ID.trim() && env.PLAID_SECRET.trim()) return { config: env, source: "env" };
  const [row] = await db.select().from(plaidSettings).where(eq(plaidSettings.ownerId, ownerId));
  if (!row)
    return {
      source: "none",
      config: {
        ...env,
        PLAID_ENABLED: "false",
        PLAID_CLIENT_ID: "",
        PLAID_SECRET: "",
        PLAID_REDIRECT_URI: "",
      },
    };
  return {
    source: "settings",
    config: {
      ...env,
      PLAID_ENV: row.environment,
      PLAID_ENABLED: row.enabled ? "true" : "false",
      PLAID_CLIENT_ID: row.clientId,
      PLAID_SECRET: decryptSecret(row.secretEnc, env.APP_SECRET, "plaid-secret"),
      PLAID_REDIRECT_URI: row.redirectUri ?? "",
    },
  };
}
