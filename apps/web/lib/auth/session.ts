import { randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { sessions, users } from "@/db/schema";
import { systemClock, type AppDb, type Clock } from "@/db/types";
import { hashToken } from "./crypto";
export const SESSION_COOKIE = "al_session";
export const IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
export function sessionCookieOptions(appUrl: string) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: new URL(appUrl).protocol === "https:",
    path: "/",
    maxAge: ABSOLUTE_MS / 1000,
  };
}
export async function createSession(
  db: AppDb,
  userId: string,
  metadata: { ipHash: string; userAgent: string; oldToken?: string },
  clock: Clock = systemClock,
) {
  const now = clock();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + ABSOLUTE_MS);
  await db.transaction(async (tx) => {
    if (metadata.oldToken) await logout(tx, userId, metadata.oldToken);
    await tx.insert(sessions).values({
      userId,
      tokenHash: hashToken(token),
      ipHash: metadata.ipHash,
      userAgent: metadata.userAgent.slice(0, 512),
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      expiresAt,
    });
  });
  return { token, expiresAt };
}
export async function validateSession(db: AppDb, token: string | undefined, clock: Clock = systemClock) {
  if (!token || !/^[\w-]{43}$/.test(token)) return null;
  const now = clock();
  const conditions = and(
    eq(sessions.tokenHash, hashToken(token)),
    gt(sessions.expiresAt, now),
    gt(sessions.lastSeenAt, new Date(now.getTime() - IDLE_MS)),
    gt(sessions.createdAt, new Date(now.getTime() - ABSOLUTE_MS)),
  );
  const [session] = await db
    .update(sessions)
    .set({ lastSeenAt: now, updatedAt: now })
    .where(conditions)
    .returning({ id: sessions.id, userId: sessions.userId, expiresAt: sessions.expiresAt });
  if (!session) return null;
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      baseCurrency: users.baseCurrency,
      timezone: users.timezone,
      totpEnabledAt: users.totpEnabledAt,
    })
    .from(users)
    .where(eq(users.id, session.userId));
  return user ? { session, user } : null;
}
export async function logout(db: AppDb, userId: string, token: string) {
  await db.delete(sessions).where(and(eq(sessions.userId, userId), eq(sessions.tokenHash, hashToken(token))));
}
