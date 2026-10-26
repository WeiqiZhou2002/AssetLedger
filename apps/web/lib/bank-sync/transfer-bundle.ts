import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { hashRaw } from "@node-rs/argon2";
import { z } from "zod";
import { invariant, LedgerError } from "@/lib/ledger/errors";

export const MAX_TRANSFER_BYTES = 256 * 1024;
export const transferPassphrase = z.string().min(12).max(1024);
const environment = z.enum(["sandbox", "production"]);
const text = z.string().min(1).max(1000);
const accountSchema = z
  .object({
    plaidAccountId: text,
    name: text,
    officialName: text.nullable(),
    mask: z.string().max(10).nullable(),
    type: text,
    subtype: text.nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
  })
  .strict();
const connectionSchema = z
  .object({
    plaidItemId: text,
    accessToken: text,
    environment,
    institutionId: text.nullable(),
    institutionName: text,
    products: z.array(text).max(25),
    autoPost: z.boolean(),
    importFromDate: z.iso.date(),
    daysRequested: z.number().int().min(1).max(730),
    accounts: z.array(accountSchema).max(100),
  })
  .strict();
const payloadSchema = z.object({ connections: z.array(connectionSchema).min(1).max(25) }).strict();
export type TransferConnection = z.infer<typeof connectionSchema>;
const base64url = (bytes?: number) =>
  z
    .string()
    .min(1)
    .max(MAX_TRANSFER_BYTES)
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine((value) => {
      const decoded = Buffer.from(value, "base64url");
      return decoded.toString("base64url") === value && (bytes === undefined || decoded.length === bytes);
    });
const envelopeSchema = z
  .object({
    format: z.literal("asset-ledger-plaid-connections"),
    version: z.literal(1),
    environment,
    createdAt: z.iso.datetime(),
    kdf: z
      .object({
        alg: z.literal("argon2id"),
        salt: base64url(16),
        memoryCost: z.number().int().min(65536).max(262144),
        timeCost: z.number().int().min(3).max(10),
        parallelism: z.literal(1),
      })
      .strict(),
    iv: base64url(12),
    tag: base64url(16),
    ciphertext: base64url(),
  })
  .strict();
type Envelope = z.infer<typeof envelopeSchema>;
type Header = Pick<Envelope, "format" | "version" | "environment" | "createdAt" | "kdf">;
function aad(header: Header) {
  // Fixed field order at both levels makes authentication independent of JSON property order on disk.
  return Buffer.from(
    JSON.stringify({
      format: header.format,
      version: header.version,
      environment: header.environment,
      createdAt: header.createdAt,
      kdf: {
        alg: header.kdf.alg,
        salt: header.kdf.salt,
        memoryCost: header.kdf.memoryCost,
        timeCost: header.kdf.timeCost,
        parallelism: header.kdf.parallelism,
      },
    }),
  );
}
function key(passphrase: string, kdf: Envelope["kdf"]) {
  return hashRaw(transferPassphrase.parse(passphrase), {
    algorithm: 2,
    version: 1,
    salt: Buffer.from(kdf.salt, "base64url"),
    memoryCost: kdf.memoryCost,
    timeCost: kdf.timeCost,
    parallelism: kdf.parallelism,
    outputLen: 32,
  });
}
export async function encryptTransferBundle(
  connections: TransferConnection[],
  env: Envelope["environment"],
  passphrase: string,
  now = new Date(),
): Promise<Envelope> {
  const payload = payloadSchema.parse({ connections });
  invariant(
    payload.connections.every((row) => row.environment === env),
    "连接所属环境不一致",
  );
  const plaintext = Buffer.from(JSON.stringify(payload));
  invariant(plaintext.length <= MAX_TRANSFER_BYTES * 0.7, "连接文件超过 256 KB，请分批导出");
  const kdf: Envelope["kdf"] = {
    alg: "argon2id",
    salt: randomBytes(16).toString("base64url"),
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  };
  const header: Header = {
    format: "asset-ledger-plaid-connections",
    version: 1,
    environment: env,
    createdAt: now.toISOString(),
    kdf,
  };
  const derived = await key(passphrase, kdf);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", derived, iv);
    cipher.setAAD(aad(header));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      ...header,
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
  } finally {
    derived.fill(0);
    plaintext.fill(0);
  }
}
export async function decryptTransferBundle(file: string, passphrase: string) {
  invariant(Buffer.byteLength(file) <= MAX_TRANSFER_BYTES, "连接文件不能超过 256 KB");
  let envelope: Envelope;
  try {
    envelope = envelopeSchema.parse(JSON.parse(file));
  } catch {
    throw new LedgerError("连接文件格式、版本或加密参数无效");
  }
  const derived = await key(passphrase, envelope.kdf);
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", derived, Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(aad(envelope));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);
    const payload = payloadSchema.parse(JSON.parse(plaintext.toString("utf8")));
    invariant(
      payload.connections.every((row) => row.environment === envelope.environment),
      "环境无效",
    );
    return { environment: envelope.environment, ...payload };
  } catch {
    throw new LedgerError("口令错误或文件已损坏");
  } finally {
    derived.fill(0);
    plaintext?.fill(0);
  }
}
