import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { systemClock, type AppDb, type Clock } from "@/db/types";
import { getDummyHash, verifyPassword } from "./password";
import { createChallenge, readChallenge } from "./challenge";
import { createSession } from "./session";
import { hashToken, privateHash } from "./crypto";
import { limitedAttempt, rateKeys } from "./rate-limit";
import { consumeTotp } from "./totp";
import { auditAuth } from "./audit";
type Context = { appSecret: string; ip: string; userAgent: string; oldToken?: string };
export type LoginResult =
  { ok: false } | { ok: true; challenge: string } | { ok: true; token: string; expiresAt: Date };
export async function loginPassword(
  db: AppDb,
  email: string,
  password: string,
  context: Context,
  clock: Clock = systemClock,
): Promise<LoginResult> {
  const normalizedEmail = email.trim().toLowerCase();
  return limitedAttempt(
    db,
    rateKeys(normalizedEmail, context.ip, context.appSecret),
    async (tx): Promise<LoginResult> => {
      const [user] = await tx.select().from(users).where(eq(users.email, normalizedEmail));
      const valid = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), password);
      if (!valid || !user) return { ok: false };
      const ipHash = privateHash(context.ip, context.appSecret);
      if (user.totpEnabledAt)
        return {
          ok: true,
          challenge: createChallenge(
            {
              userId: user.id,
              passwordFingerprint: hashToken(user.passwordHash),
              ipHash,
              issuedAt: clock().getTime(),
            },
            context.appSecret,
          ),
        };
      const session = await createSession(tx, user.id, { ...context, ipHash }, clock);
      await auditAuth(tx, user.id, "session.login");
      return { ok: true, ...session };
    },
    clock,
  );
}
export async function loginTotp(
  db: AppDb,
  challengeValue: string | undefined,
  code: string,
  context: Context,
  clock: Clock = systemClock,
): Promise<LoginResult> {
  const challenge = readChallenge(challengeValue, context.appSecret, clock());
  const [user] = challenge ? await db.select().from(users).where(eq(users.id, challenge.userId)) : [];
  return limitedAttempt(
    db,
    rateKeys(user?.email ?? "invalid-challenge", context.ip, context.appSecret),
    async (tx): Promise<LoginResult> => {
      if (
        !challenge ||
        !user ||
        challenge.passwordFingerprint !== hashToken(user.passwordHash) ||
        challenge.ipHash !== privateHash(context.ip, context.appSecret)
      )
        return { ok: false };
      if (!(await consumeTotp(tx, user.id, code, context.appSecret, clock))) return { ok: false };
      const session = await createSession(tx, user.id, { ...context, ipHash: challenge.ipHash }, clock);
      await auditAuth(tx, user.id, "session.login_totp");
      return { ok: true, ...session };
    },
    clock,
  );
}
