import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { z } from "zod";
import type { BankClient, WebhookKey } from "./types";

const keys = new Map<string, WebhookKey>();
const headerSchema = z.object({ alg: z.literal("ES256"), kid: z.string().min(1).max(200) });
const claimsSchema = z.object({
  iat: z.number().int(),
  request_body_sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const keySchema = z.object({
  kid: z.string(),
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  alg: z.literal("ES256"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expired_at: z.number().finite().nullable(),
});
export class WebhookVerificationError extends Error {}
function reject(reason: string): never {
  throw new WebhookVerificationError(reason);
}
function decode(value: string) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    return reject("invalid_jwt");
  }
}

export async function verifyPlaidWebhook(
  body: Uint8Array,
  jwt: string | null,
  client: Pick<BankClient, "webhookKey">,
  now = new Date(),
) {
  if (!jwt || jwt.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt))
    reject("invalid_jwt");
  const [encodedHeader, encodedClaims, encodedSignature] = jwt.split(".");
  const header = headerSchema.safeParse(decode(encodedHeader));
  if (!header.success) reject("invalid_header");
  const seconds = now.getTime() / 1000;
  let key = keys.get(header.data.kid);
  if (key?.expired_at !== null && key?.expired_at !== undefined && key.expired_at <= seconds) {
    keys.delete(header.data.kid);
    key = undefined;
  }
  if (!key) {
    let fetched: unknown;
    try {
      fetched = await client.webhookKey(header.data.kid);
    } catch {
      reject("key_unavailable");
    }
    const parsed = keySchema.safeParse(fetched);
    if (!parsed.success || parsed.data.kid !== header.data.kid) reject("invalid_key");
    key = parsed.data;
    if (key.expired_at !== null && key.expired_at <= seconds) reject("expired_key");
    if (keys.size >= 256) keys.delete(keys.keys().next().value!);
    keys.set(header.data.kid, key);
  }
  let valid = false;
  try {
    valid = verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      { key: createPublicKey({ key, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      Buffer.from(encodedSignature, "base64url"),
    );
  } catch {
    reject("invalid_signature");
  }
  if (!valid) reject("invalid_signature");
  const claims = claimsSchema.safeParse(decode(encodedClaims));
  if (!claims.success) reject("invalid_claims");
  if (claims.data.iat > seconds + 60 || seconds - claims.data.iat > 300) reject("invalid_iat");
  const hash = createHash("sha256").update(body).digest();
  if (!timingSafeEqual(hash, Buffer.from(claims.data.request_body_sha256, "hex")))
    reject("body_hash_mismatch");
}
