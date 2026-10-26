import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
function deriveKey(appSecret: string, purpose: string) {
  if (appSecret.length < 32) throw new Error("APP_SECRET 至少需要 32 个字符");
  return Buffer.from(hkdfSync("sha256", appSecret, "asset-ledger-v1", purpose, 32));
}
export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export function privateHash(value: string, appSecret: string) {
  return createHmac("sha256", deriveKey(appSecret, "private-identifiers")).update(value).digest("hex");
}
export function encryptSecret(plaintext: string, appSecret: string, purpose = "totp") {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(appSecret, purpose), iv);
  cipher.setAAD(Buffer.from(`asset-ledger:${purpose}:v1`));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}
export function decryptSecret(payload: string, appSecret: string, purpose = "totp") {
  const [version, iv, tag, ciphertext, extra] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext || extra) throw new Error("密文无效");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(appSecret, purpose),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(`asset-ledger:${purpose}:v1`));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString(
    "utf8",
  );
}
