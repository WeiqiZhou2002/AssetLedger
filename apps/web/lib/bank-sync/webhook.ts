import { and, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "@/db/types";
import { bankConnections } from "@/db/schema";
import { HttpError, json } from "@/lib/auth/http";
import { privateHash } from "@/lib/auth/crypto";
import { assertRateLimit, clientIp, limitedAttempt, RateLimitError } from "@/lib/auth/rate-limit";
import { importLock } from "@/lib/imports/store";
import { auditLedger } from "@/lib/ledger/audit";
import { loadPlaidConfig } from "./config";
import { PlaidClient } from "./plaid-client";
import { verifyPlaidWebhook, WebhookVerificationError } from "./webhook-verification";
import type { BankClient, PlaidConfig } from "./types";

const routingSchema = z.object({
  item_id: z.string().min(1).max(200),
  environment: z.enum(["sandbox", "production"]),
  webhook_type: z.string().optional(),
  webhook_code: z.string().optional(),
});
async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new WebhookVerificationError("empty_body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 64 * 1024) {
      await reader.cancel();
      throw new HttpError(413, "请求内容过长");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function receivePlaidWebhook(
  db: AppDb,
  request: Request,
  env: PlaidConfig & { TRUST_CLOUDFLARE_HEADERS: "true" | "false" },
  makeClient: (config: PlaidConfig) => BankClient = (config) =>
    new PlaidClient(config, AbortSignal.timeout(5000)),
  now = new Date(),
) {
  const keys = [
    privateHash(
      `plaid-webhook:${clientIp(request.headers, env.TRUST_CLOUDFLARE_HEADERS === "true")}`,
      env.APP_SECRET,
    ),
  ];
  const clock = () => now;
  try {
    await assertRateLimit(db, keys, clock);
    let raw: Buffer;
    let body: z.infer<typeof routingSchema>;
    try {
      raw = await readBody(request);
      const parsed = routingSchema.safeParse(JSON.parse(raw.toString("utf8")));
      if (!parsed.success) throw new WebhookVerificationError("invalid_body");
      body = parsed.data;
      // Unverified routing hints only select credentials; they never authorize a mutation.
      const candidates = await db
        .select({ id: bankConnections.id, ownerId: bankConnections.ownerId })
        .from(bankConnections)
        .where(
          and(
            eq(bankConnections.plaidItemId, body.item_id),
            eq(bankConnections.environment, body.environment),
            ne(bankConnections.status, "revoked"),
          ),
        );
      const eligible: typeof candidates = [];
      let verifier: BankClient | undefined;
      for (const candidate of candidates) {
        const { config } = await loadPlaidConfig(db, candidate.ownerId, env);
        if (config.PLAID_ENABLED !== "true" || config.PLAID_ENV !== body.environment) continue;
        eligible.push(candidate);
        verifier ??= makeClient(config);
      }
      if (!verifier) return json({ ok: true });
      await verifyPlaidWebhook(raw, request.headers.get("Plaid-Verification"), verifier, now);
      if (body.webhook_type === "ITEM" && body.webhook_code === "NEW_ACCOUNTS_AVAILABLE") {
        for (const candidate of eligible) {
          await db.transaction(async (tx) => {
            await importLock(tx, candidate.ownerId);
            const [updated] = await tx
              .update(bankConnections)
              .set({ newAccountsAvailableAt: now })
              .where(
                and(
                  eq(bankConnections.ownerId, candidate.ownerId),
                  eq(bankConnections.id, candidate.id),
                  ne(bankConnections.status, "revoked"),
                  isNull(bankConnections.newAccountsAvailableAt),
                ),
              )
              .returning({ id: bankConnections.id });
            if (updated)
              await auditLedger(
                tx,
                candidate.ownerId,
                "bank_connection",
                updated.id,
                "bank.new_accounts_available",
              );
          });
        }
      }
      return json({ ok: true });
    } catch (error) {
      const reason =
        error instanceof WebhookVerificationError
          ? error.message
          : error instanceof SyntaxError
            ? "invalid_body"
            : error instanceof HttpError && error.status === 413
              ? "body_too_large"
              : null;
      // Key lookup failures are retryable infrastructure errors, not rejected signatures.
      if (!reason || reason === "key_unavailable") throw error;
      await limitedAttempt(db, keys, async () => ({ ok: false }), clock);
      console.error(JSON.stringify({ kind: "plaid_webhook_rejected", reason }));
      return json({ error: "通知验证失败" }, reason === "body_too_large" ? 413 : 401);
    }
  } catch (error) {
    if (error instanceof RateLimitError) {
      const response = json({ error: error.message }, 429);
      response.headers.set("Retry-After", "900");
      return response;
    }
    console.error(JSON.stringify({ kind: "plaid_webhook_failed" }));
    return json({ error: "服务暂不可用" }, 503);
  }
}
