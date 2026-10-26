import * as OTPAuth from "otpauth";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { users, sessions } from "@/db/schema";
import { systemClock, type AppDb, type Clock } from "@/db/types";
import { decryptSecret, encryptSecret } from "./crypto";
import { auditAuth } from "./audit";
export function makeTotp(secret: string, email = "owner") {
  return new OTPAuth.TOTP({
    issuer: "Asset Ledger",
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}
export function verifyTotp(secret: string, code: string, now: Date): bigint | null {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = makeTotp(secret).validate({ token: code, timestamp: now.getTime(), window: 1 });
  return delta === null ? null : BigInt(Math.floor(now.getTime() / 30000) + delta);
}
export async function startTotpEnrollment(
  db: AppDb,
  userId: string,
  appSecret: string,
  clock: Clock = systemClock,
) {
  const now = clock();
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const [user] = await db
    .update(users)
    .set({
      totpPendingSecretEnc: encryptSecret(secret, appSecret),
      totpPendingExpiresAt: new Date(now.getTime() + 10 * 60000),
      updatedAt: now,
    })
    .where(and(eq(users.id, userId), isNull(users.totpEnabledAt)))
    .returning({ email: users.email });
  if (!user) throw new Error("两步验证已启用");
  return { uri: makeTotp(secret, user.email).toString(), secret };
}
export async function enableTotp(
  db: AppDb,
  userId: string,
  code: string,
  appSecret: string,
  clock: Clock = systemClock,
) {
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    const now = clock();
    if (
      !user ||
      user.totpEnabledAt ||
      !user.totpPendingSecretEnc ||
      !user.totpPendingExpiresAt ||
      user.totpPendingExpiresAt <= now
    )
      return false;
    const step = verifyTotp(decryptSecret(user.totpPendingSecretEnc, appSecret), code, now);
    if (step === null) return false;
    await tx
      .update(users)
      .set({
        totpSecretEnc: user.totpPendingSecretEnc,
        totpEnabledAt: now,
        totpLastUsedStep: step,
        totpPendingSecretEnc: null,
        totpPendingExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(users.id, userId));
    await auditAuth(tx, userId, "totp.enable", { totpEnabled: true });
    return true;
  });
}
export async function consumeTotp(
  db: AppDb,
  userId: string,
  code: string,
  appSecret: string,
  clock: Clock = systemClock,
) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user?.totpSecretEnc || !user.totpEnabledAt) return false;
  const now = clock();
  const step = verifyTotp(decryptSecret(user.totpSecretEnc, appSecret), code, now);
  if (step === null) return false;
  const changed = await db
    .update(users)
    .set({ totpLastUsedStep: step, updatedAt: now })
    .where(
      and(
        eq(users.id, userId),
        eq(users.totpSecretEnc, user.totpSecretEnc),
        or(isNull(users.totpLastUsedStep), lt(users.totpLastUsedStep, step)),
      ),
    )
    .returning({ id: users.id });
  return changed.length === 1;
}
export async function disableTotp(
  db: AppDb,
  userId: string,
  code: string,
  appSecret: string,
  clock: Clock = systemClock,
) {
  return db.transaction(async (tx) => {
    if (!(await consumeTotp(tx, userId, code, appSecret, clock))) return false;
    await tx
      .update(users)
      .set({
        totpSecretEnc: null,
        totpEnabledAt: null,
        totpLastUsedStep: null,
        totpPendingSecretEnc: null,
        totpPendingExpiresAt: null,
        updatedAt: clock(),
      })
      .where(eq(users.id, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await auditAuth(tx, userId, "totp.disable", { totpEnabled: false });
    return true;
  });
}
