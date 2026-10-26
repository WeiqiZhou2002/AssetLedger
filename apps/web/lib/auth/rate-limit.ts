import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import { isIP } from "node:net";
import { loginAttempts } from "@/db/schema";
import { systemClock, type AppDb, type Clock } from "@/db/types";
import { privateHash } from "./crypto";
export const RATE_WINDOW_MS = 15 * 60 * 1000;
export const RATE_LIMIT = 5;
export class RateLimitError extends Error {
  readonly status = 429;
  constructor() {
    super("尝试次数过多，请在 15 分钟后重试");
  }
}
export function clientIp(headers: Headers, trustCloudflare: boolean) {
  const ip = trustCloudflare ? headers.get("cf-connecting-ip") : null;
  return ip && isIP(ip) ? ip : "untrusted-client";
}
export function rateKeys(email: string, ip: string, appSecret: string) {
  return [
    privateHash(`email:${email.trim().toLowerCase()}`, appSecret),
    privateHash(`ip:${ip}`, appSecret),
  ].sort();
}
export async function assertRateLimit(db: AppDb, keys: string[], clock: Clock = systemClock) {
  const rows = await db
    .select({ key: loginAttempts.keyHash, failures: count() })
    .from(loginAttempts)
    .where(
      and(
        inArray(loginAttempts.keyHash, keys),
        eq(loginAttempts.succeeded, false),
        gt(loginAttempts.createdAt, new Date(clock().getTime() - RATE_WINDOW_MS)),
      ),
    )
    .groupBy(loginAttempts.keyHash);
  if (rows.some((row) => row.failures >= RATE_LIMIT)) throw new RateLimitError();
}
export async function recordAttempt(
  db: AppDb,
  keys: string[],
  succeeded: boolean,
  clock: Clock = systemClock,
) {
  const now = clock();
  await db
    .insert(loginAttempts)
    .values(keys.map((keyHash) => ({ keyHash, succeeded, createdAt: now, updatedAt: now })));
}
export async function limitedAttempt<T extends { ok: boolean }>(
  db: AppDb,
  keys: string[],
  attempt: (tx: AppDb) => Promise<T>,
  clock: Clock = systemClock,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Sorted transaction locks serialize attempts sharing either IP or email, including parallel requests.
    for (const key of [...new Set(keys)].sort())
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    await assertRateLimit(tx, keys, clock);
    const result = await attempt(tx);
    await recordAttempt(tx, keys, result.ok, clock);
    return result;
  });
}
