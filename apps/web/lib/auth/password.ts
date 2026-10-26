import { hash, verify } from "@node-rs/argon2";
export function hashPassword(password: string) {
  if (password.length < 12 || password.length > 1024) throw new Error("密码须为 12–1024 个字符");
  return hash(password, {
    algorithm: 2 /* Argon2id: NAPI exposes an ambient const enum */,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
    outputLen: 32,
  });
}
export async function verifyPassword(passwordHash: string, password: string) {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
let dummyHash: Promise<string> | undefined;
export function getDummyHash() {
  return (dummyHash ??= hashPassword("synthetic-unused-password-for-timing"));
}
