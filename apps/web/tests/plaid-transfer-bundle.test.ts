import { beforeAll, expect, it } from "vitest";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { hashRaw } from "@node-rs/argon2";
import {
  decryptTransferBundle,
  encryptTransferBundle,
  MAX_TRANSFER_BYTES,
  type TransferConnection,
} from "@/lib/bank-sync/transfer-bundle";
const passphrase = "synthetic-transfer-passphrase";
export const syntheticConnection: TransferConnection = {
  plaidItemId: "synthetic-item",
  accessToken: "access-sandbox-SYNTHETIC-TRANSFER-ONLY",
  environment: "sandbox",
  institutionId: "ins_synthetic",
  institutionName: "Example Bank",
  products: ["transactions"],
  autoPost: false,
  importFromDate: "2026-08-01",
  daysRequested: 90,
  accounts: [
    {
      plaidAccountId: "bank",
      name: "Example Checking",
      officialName: null,
      mask: "1234",
      type: "depository",
      subtype: "checking",
      currency: "USD",
    },
  ],
};
let bundle: Awaited<ReturnType<typeof encryptTransferBundle>>;
function headerAad(value: typeof bundle) {
  return Buffer.from(
    JSON.stringify({
      format: value.format,
      version: value.version,
      environment: value.environment,
      createdAt: value.createdAt,
      kdf: {
        alg: value.kdf.alg,
        salt: value.kdf.salt,
        memoryCost: value.kdf.memoryCost,
        timeCost: value.kdf.timeCost,
        parallelism: value.kdf.parallelism,
      },
    }),
  );
}
function bundleKey() {
  return hashRaw(passphrase, {
    algorithm: 2,
    salt: Buffer.from(bundle.kdf.salt, "base64url"),
    memoryCost: bundle.kdf.memoryCost,
    timeCost: bundle.kdf.timeCost,
    parallelism: bundle.kdf.parallelism,
    outputLen: 32,
  });
}
beforeAll(async () => {
  bundle = await encryptTransferBundle([syntheticConnection], "sandbox", passphrase);
});
it("roundtrips only the allowed payload and never exposes credentials in the file", async () => {
  const file = JSON.stringify(bundle);
  expect(file).not.toContain(syntheticConnection.accessToken);
  expect(file).not.toContain(passphrase);
  expect(file).not.toContain(syntheticConnection.institutionName);
  expect(bundle.kdf).toMatchObject({ alg: "argon2id", memoryCost: 65536, timeCost: 3, parallelism: 1 });
  expect(await decryptTransferBundle(file, passphrase)).toEqual({
    environment: "sandbox",
    connections: [syntheticConnection],
  });
  const second = await encryptTransferBundle([syntheticConnection], "sandbox", passphrase);
  expect(second.iv).not.toBe(bundle.iv);
  expect(second.kdf.salt).not.toBe(bundle.kdf.salt);
});
it("rejects a wrong passphrase generically", async () => {
  await expect(decryptTransferBundle(JSON.stringify(bundle), "synthetic-wrong-passphrase")).rejects.toThrow(
    "口令错误或文件已损坏",
  );
});
it.each(["iv", "tag", "ciphertext"] as const)("authenticates tampered %s", async (field) => {
  const bytes = Buffer.from(bundle[field], "base64url");
  bytes[0] ^= 1;
  await expect(
    decryptTransferBundle(JSON.stringify({ ...bundle, [field]: bytes.toString("base64url") }), passphrase),
  ).rejects.toThrow("口令错误或文件已损坏");
});
it("binds environment to AAD", async () => {
  await expect(
    decryptTransferBundle(JSON.stringify({ ...bundle, environment: "production" }), passphrase),
  ).rejects.toThrow("口令错误或文件已损坏");
});
it("authenticates the full canonical header with an independent AES-GCM decoder", async () => {
  const decipher = createDecipheriv("aes-256-gcm", await bundleKey(), Buffer.from(bundle.iv, "base64url"));
  decipher.setAAD(headerAad(bundle));
  decipher.setAuthTag(Buffer.from(bundle.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(bundle.ciphertext, "base64url")),
    decipher.final(),
  ]);
  expect(JSON.parse(plaintext.toString("utf8"))).toEqual({ connections: [syntheticConnection] });
});
it("rejects tampering with createdAt", async () => {
  const createdAt = new Date(Date.parse(bundle.createdAt) + 1000).toISOString();
  await expect(decryptTransferBundle(JSON.stringify({ ...bundle, createdAt }), passphrase)).rejects.toThrow(
    "口令错误或文件已损坏",
  );
});
it.each(["salt", "memoryCost", "timeCost"] as const)(
  "rejects tampering with the valid KDF field %s",
  async (field) => {
    const salt = Buffer.from(bundle.kdf.salt, "base64url");
    salt[0] ^= 1;
    const changes = {
      salt: salt.toString("base64url"),
      memoryCost: bundle.kdf.memoryCost + 8,
      timeCost: bundle.kdf.timeCost + 1,
    };
    await expect(
      decryptTransferBundle(
        JSON.stringify({ ...bundle, kdf: { ...bundle.kdf, [field]: changes[field] } }),
        passphrase,
      ),
    ).rejects.toThrow("口令错误或文件已损坏");
  },
);
it.each([{ alg: "argon2i" }, { parallelism: 2 }])(
  "rejects tampering with fixed KDF fields: %j",
  async (change) => {
    await expect(
      decryptTransferBundle(JSON.stringify({ ...bundle, kdf: { ...bundle.kdf, ...change } }), passphrase),
    ).rejects.toThrow("连接文件格式、版本或加密参数无效");
  },
);
it("ignores JSON property order while authenticating header values", async () => {
  const reordered = Object.fromEntries(
    Object.entries({
      ...bundle,
      kdf: Object.fromEntries(Object.entries(bundle.kdf).reverse()),
    }).reverse(),
  );
  expect(await decryptTransferBundle(JSON.stringify(reordered, null, 2), passphrase)).toEqual({
    environment: "sandbox",
    connections: [syntheticConnection],
  });
});
it.each([
  { memoryCost: 262145 },
  { memoryCost: 65535 },
  { memoryCost: -1 },
  { timeCost: 11 },
  { timeCost: 0 },
  { timeCost: 3.5 },
  { parallelism: 255 },
  { alg: "argon2d" },
  { salt: "AA" },
])("rejects unsafe KDF parameters before deriving a key: %j", async (change) => {
  await expect(
    decryptTransferBundle(JSON.stringify({ ...bundle, kdf: { ...bundle.kdf, ...change } }), passphrase),
  ).rejects.toThrow("连接文件格式、版本或加密参数无效");
});
it.each([{ version: 2 }, { format: "other" }, { iv: "invalid=" }, { tag: "AA" }])(
  "rejects invalid envelope %j",
  async (change) => {
    await expect(decryptTransferBundle(JSON.stringify({ ...bundle, ...change }), passphrase)).rejects.toThrow(
      "连接文件格式、版本或加密参数无效",
    );
  },
);
it("bounds both file size and decrypted connection count", async () => {
  await expect(decryptTransferBundle("x".repeat(MAX_TRANSFER_BYTES + 1), passphrase)).rejects.toThrow(
    "256 KB",
  );
  // Construct an authenticated oversized payload independently of the export validator.
  const key = await bundleKey();
  const cipher = createCipheriv("aes-256-gcm", key, Buffer.from(bundle.iv, "base64url"));
  cipher.setAAD(headerAad(bundle));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ connections: Array.from({ length: 26 }, () => syntheticConnection) })),
    cipher.final(),
  ]);
  await expect(
    decryptTransferBundle(
      JSON.stringify({
        ...bundle,
        tag: cipher.getAuthTag().toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      }),
      passphrase,
    ),
  ).rejects.toThrow("口令错误或文件已损坏");
});
