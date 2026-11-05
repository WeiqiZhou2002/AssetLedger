import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb } from "./helpers/db";
import { FakePlaid, plaidConfig, plaidFailure } from "./helpers/plaid";
import { auditLogs, bankConnections, importJobs, loginAttempts, users } from "@/db/schema";
import { receivePlaidWebhook } from "@/lib/bank-sync/webhook";
import { verifyPlaidWebhook } from "@/lib/bank-sync/webhook-verification";
import type { WebhookKey } from "@/lib/bank-sync/types";

let h: Awaited<ReturnType<typeof createTestDb>>;
let client: FakePlaid;
let connectionId: string;
let ownerId: string;
const now = new Date("2026-11-01T12:00:00Z");
const env: Parameters<typeof receivePlaidWebhook>[2] = { ...plaidConfig, TRUST_CLOUDFLARE_HEADERS: "true" };
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const publicKey = pair.publicKey.export({ format: "jwk" });
let kid: string;
const payload = {
  webhook_type: "ITEM",
  webhook_code: "NEW_ACCOUNTS_AVAILABLE",
  item_id: "synthetic-webhook-item",
  environment: "sandbox",
};
function jwt(body: string, options: { alg?: string; kid?: string; iat?: number; hash?: string } = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: options.alg ?? "ES256", kid: options.kid ?? kid }),
  ).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      iat: options.iat ?? now.getTime() / 1000,
      request_body_sha256: options.hash ?? createHash("sha256").update(body).digest("hex"),
    }),
  ).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: pair.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${claims}.${signature}`;
}
function request(body = JSON.stringify(payload), token: string | null = jwt(body), ip = "192.0.2.1") {
  return new Request("https://ledger.example.test/api/plaid/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": ip,
      ...(token ? { "Plaid-Verification": token } : {}),
    },
    body,
  });
}
const receive = (req = request(), config = env) => receivePlaidWebhook(h.db, req, config, () => client, now);
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.client.close();
});
beforeEach(async () => {
  await h.db.execute(sql`truncate users, login_attempts cascade`);
  const [owner] = await h.db
    .insert(users)
    .values({ email: "webhook@example.test", passwordHash: "synthetic" })
    .returning();
  ownerId = owner.id;
  const [connection] = await h.db
    .insert(bankConnections)
    .values({
      ownerId,
      environment: "sandbox",
      plaidItemId: payload.item_id,
      institutionName: "Example Bank",
      accessTokenEnc: "unused-synthetic",
      importFromDate: "2026-10-01",
    })
    .returning();
  connectionId = connection.id;
  client = new FakePlaid();
  kid = randomUUID();
  client.webhookKeys.set(kid, { ...publicKey, kid, alg: "ES256", expired_at: null } as WebhookKey);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("verifies exact raw bytes, accepts without session/origin, caches keys and audits duplicate delivery once", async () => {
  const raw = JSON.stringify(payload, null, 2) + "\n";
  expect((await receive(request(raw))).status).toBe(200);
  expect((await receive(request(raw))).status).toBe(200);
  expect(client.keyRequests).toEqual([kid]);
  const [connection] = await h.db.select().from(bankConnections).where(eq(bankConnections.id, connectionId));
  expect(connection.newAccountsAvailableAt).toEqual(now);
  expect(connection.status).toBe("active");
  const logs = await h.db.select().from(auditLogs);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({
    entityId: connectionId,
    ownerId,
    action: "bank.new_accounts_available",
    changes: {},
  });
  expect(JSON.stringify(logs)).not.toContain(payload.item_id);
  expect(await h.db.select().from(importJobs)).toHaveLength(0);
});

it.each([
  "wrong_alg",
  "invalid_key",
  "mismatched_key",
  "expired_key",
  "old_iat",
  "future_iat",
  "body_hash",
  "signature",
  "missing_jwt",
  "malformed_jwt",
])("rejects %s with 401 and no mutation", async (failure) => {
  const raw = JSON.stringify(payload);
  let token: string | null = jwt(raw);
  if (failure === "wrong_alg") token = jwt(raw, { alg: "HS256" });
  if (failure === "invalid_key") client.webhookKeys.get(kid)!.kty = "RSA";
  if (failure === "mismatched_key") client.webhookKeys.get(kid)!.kid = "different-synthetic-key";
  if (failure === "expired_key") client.webhookKeys.get(kid)!.expired_at = now.getTime() / 1000 - 1;
  if (failure === "old_iat") token = jwt(raw, { iat: now.getTime() / 1000 - 301 });
  if (failure === "future_iat") token = jwt(raw, { iat: now.getTime() / 1000 + 120 });
  if (failure === "body_hash") token = jwt(raw, { hash: "0".repeat(64) });
  if (failure === "signature") {
    const parts = token.split(".");
    const signature = Buffer.from(parts[2], "base64url");
    signature[0] ^= 1;
    token = `${parts[0]}.${parts[1]}.${signature.toString("base64url")}`;
  }
  if (failure === "missing_jwt") token = null;
  if (failure === "malformed_jwt") token = "invalid.jwt.value";
  const response = await receive(request(raw, token));
  expect(response.status).toBe(401);
  expect(await h.db.select().from(auditLogs)).toHaveLength(0);
  expect((await h.db.select().from(bankConnections))[0].newAccountsAvailableAt).toBeNull();
  expect(await h.db.select().from(loginAttempts)).toHaveLength(1);
  const logs = vi.mocked(console.error).mock.calls;
  expect(logs).toHaveLength(1);
  expect(Object.keys(JSON.parse(logs[0][0]))).toEqual(["kind", "reason"]);
  expect(logs[0][0]).not.toContain(payload.item_id);
});

it.each([-300, 30, 60])(
  "accepts iat offset %s seconds within the age and clock-skew limits",
  async (offset) => {
    const raw = JSON.stringify(payload);
    const response = await receive(request(raw, jwt(raw, { iat: now.getTime() / 1000 + offset })));
    expect(response.status).toBe(200);
    expect((await h.db.select().from(bankConnections))[0].newAccountsAvailableAt).toEqual(now);
    expect(await h.db.select().from(loginAttempts)).toHaveLength(0);
  },
);

it.each([
  { kind: "network", error: new Error("synthetic-network-failure") },
  { kind: "Plaid", error: plaidFailure("INVALID_WEBHOOK_VERIFICATION_KEY_ID") },
])(
  "returns retryable 503 for $kind key lookup failures without recording rate-limit attempts",
  async ({ error }) => {
    const lookup = vi.spyOn(client, "webhookKey").mockRejectedValue(error);
    for (let attempt = 0; attempt < 6; attempt++) expect((await receive()).status).toBe(503);
    expect(lookup).toHaveBeenCalledTimes(6);
    expect(await h.db.select().from(loginAttempts)).toHaveLength(0);
    expect(await h.db.select().from(auditLogs)).toHaveLength(0);
    expect((await h.db.select().from(bankConnections))[0].newAccountsAvailableAt).toBeNull();
    expect(
      vi
        .mocked(console.error)
        .mock.calls.every(([value]) => value === JSON.stringify({ kind: "plaid_webhook_failed" })),
    ).toBe(true);
    lookup.mockRestore();
    expect((await receive()).status).toBe(200);
    expect(await h.db.select().from(loginAttempts)).toHaveLength(0);
  },
);

it("refetches a cached key after its expiry and rejects expired keys", async () => {
  client.webhookKeys.get(kid)!.expired_at = now.getTime() / 1000 + 1;
  const raw = JSON.stringify(payload);
  await verifyPlaidWebhook(Buffer.from(raw), jwt(raw), client, now);
  await expect(
    verifyPlaidWebhook(Buffer.from(raw), jwt(raw), client, new Date(now.getTime() + 2000)),
  ).rejects.toThrow("expired_key");
  expect(client.keyRequests).toEqual([kid, kid]);
});

it.each(["unknown_item", "environment_mismatch", "disabled", "revoked"])(
  "ignores %s before fetching verification keys",
  async (condition) => {
    let body = payload;
    let config = env;
    if (condition === "unknown_item") body = { ...payload, item_id: "not-this-install" };
    if (condition === "environment_mismatch") config = { ...env, PLAID_ENV: "production" };
    if (condition === "disabled") config = { ...env, PLAID_ENABLED: "false" };
    if (condition === "revoked") await h.db.update(bankConnections).set({ status: "revoked" });
    expect((await receive(request(JSON.stringify(body), null), config)).status).toBe(200);
    expect(client.keyRequests).toEqual([]);
    expect(await h.db.select().from(auditLogs)).toHaveLength(0);
  },
);

it.each(["WEBHOOK_UPDATE_ACKNOWLEDGED", "ERROR", "DEFAULT_UPDATE"])(
  "verifies but does not act on %s",
  async (webhook_code) => {
    expect((await receive(request(JSON.stringify({ ...payload, webhook_code })))).status).toBe(200);
    expect(client.keyRequests).toEqual([kid]);
    expect(await h.db.select().from(auditLogs)).toHaveLength(0);
  },
);

it("rejects streamed bodies larger than 64 KB regardless of Content-Length", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(32000));
      controller.enqueue(new Uint8Array(34000));
      controller.close();
    },
  });
  const req = new Request("https://example.test/api/plaid/webhook", {
    method: "POST",
    body: stream,
    duplex: "half",
    headers: { "content-length": "1" },
  } as RequestInit);
  expect((await receive(req)).status).toBe(413);
  expect(client.keyRequests).toEqual([]);
});

it("rate limits rejected requests by trusted IP and ignores spoofed forwarding headers otherwise", async () => {
  for (let n = 0; n < 5; n++) expect((await receive(request(undefined, null))).status).toBe(401);
  const limited = await receive(request());
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBe("900");
  expect((await receive(request(undefined, undefined, "192.0.2.2"))).status).toBe(200);
  const untrusted = { ...env, TRUST_CLOUDFLARE_HEADERS: "false" as const };
  for (let n = 0; n < 5; n++)
    expect((await receive(request(undefined, null, `192.0.2.${n + 10}`), untrusted)).status).toBe(401);
  expect((await receive(request(undefined, null, "192.0.2.30"), untrusted)).status).toBe(429);
});
