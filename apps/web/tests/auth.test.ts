import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb } from "./helpers/db";
import { auditLogs, loginAttempts, sessions, users } from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { decryptSecret, encryptSecret, hashToken } from "@/lib/auth/crypto";
import {
  ABSOLUTE_MS,
  createSession,
  IDLE_MS,
  logout,
  sessionCookieOptions,
  validateSession,
} from "@/lib/auth/session";
import {
  assertRateLimit,
  clientIp,
  limitedAttempt,
  RATE_WINDOW_MS,
  rateKeys,
  recordAttempt,
} from "@/lib/auth/rate-limit";
import {
  consumeTotp,
  disableTotp,
  enableTotp,
  makeTotp,
  startTotpEnrollment,
  verifyTotp,
} from "@/lib/auth/totp";
import { loginPassword, loginTotp } from "@/lib/auth/login";
import { createAdmin } from "@/lib/auth/admin";
import { redactChanges } from "@/lib/auth/audit";
const secret = "synthetic-test-app-secret-32-characters-long";
const password = "synthetic-owner-password";
const baseTime = new Date("2026-01-01T00:00:00Z");
let harness: Awaited<ReturnType<typeof createTestDb>>;
let passwordHash: string;
let userId: string;
let now: Date;
const clock = () => now;
const metadata = { ipHash: "synthetic-ip-hash", userAgent: "Synthetic Test" };
const context = { appSecret: secret, ip: "untrusted-client", userAgent: "Synthetic Test" };
beforeAll(async () => {
  harness = await createTestDb();
  passwordHash = await hashPassword(password);
});
afterAll(async () => {
  await harness.client.close();
});
beforeEach(async () => {
  await harness.db.execute(sql`truncate audit_logs, login_attempts, sessions, users cascade`);
  now = new Date(baseTime);
  const [user] = await harness.db
    .insert(users)
    .values({ email: "owner@example.com", passwordHash })
    .returning();
  userId = user.id;
});
async function enrolled() {
  const setup = await startTotpEnrollment(harness.db, userId, secret, clock);
  expect(
    await enableTotp(
      harness.db,
      userId,
      makeTotp(setup.secret).generate({ timestamp: now.getTime() }),
      secret,
      clock,
    ),
  ).toBe(true);
  now = new Date(now.getTime() + 30000);
  return setup.secret;
}
describe("passwords and encryption", () => {
  it("uses Argon2id and rejects incorrect or weak passwords", async () => {
    expect(passwordHash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(passwordHash, password)).toBe(true);
    expect(await verifyPassword(passwordHash, "wrong")).toBe(false);
    expect(() => hashPassword("short")).toThrow("12");
  });
  it("encrypts with randomized authenticated ciphertext and purpose isolation", () => {
    const cipher = encryptSecret("synthetic-secret", secret);
    expect(cipher).not.toContain("synthetic-secret");
    expect(cipher).not.toBe(encryptSecret("synthetic-secret", secret));
    expect(decryptSecret(cipher, secret)).toBe("synthetic-secret");
    expect(() => decryptSecret(cipher, `${secret}wrong`)).toThrow();
    expect(() => decryptSecret(cipher, secret, "login-challenge")).toThrow();
    const parts = cipher.split(".");
    parts[2] = Buffer.alloc(16).toString("base64url");
    expect(() => decryptSecret(parts.join("."), secret)).toThrow();
    expect(() => encryptSecret("x", "short")).toThrow("APP_SECRET");
  });
  it("redacts audit changes", () => {
    expect(redactChanges({ password: "hidden", nested: { token: "hidden" }, totpEnabled: true })).toEqual({
      password: "[REDACTED]",
      nested: "[REDACTED]",
      totpEnabled: true,
    });
  });
});
describe("sessions", () => {
  it("stores only SHA-256, validates, rotates, and deletes on logout", async () => {
    const first = await createSession(harness.db, userId, metadata, clock);
    const [stored] = await harness.db.select().from(sessions);
    expect(stored.tokenHash).toBe(hashToken(first.token));
    expect(stored.tokenHash).not.toBe(first.token);
    expect((await validateSession(harness.db, first.token, clock))?.user.id).toBe(userId);
    const second = await createSession(harness.db, userId, { ...metadata, oldToken: first.token }, clock);
    expect(second.token).not.toBe(first.token);
    expect(await validateSession(harness.db, first.token, clock)).toBeNull();
    await logout(harness.db, userId, second.token);
    expect(await harness.db.select().from(sessions)).toHaveLength(0);
    expect(await validateSession(harness.db, second.token, clock)).toBeNull();
  });
  it("expires exactly at 7 idle days", async () => {
    const { token } = await createSession(harness.db, userId, metadata, clock);
    now = new Date(baseTime.getTime() + IDLE_MS);
    expect(await validateSession(harness.db, token, clock)).toBeNull();
  });
  it("renews idle time but never extends absolute 30-day expiry", async () => {
    const { token } = await createSession(harness.db, userId, metadata, clock);
    for (let days = 6; days < 30; days += 6) {
      now = new Date(baseTime.getTime() + days * 86400000);
      expect(await validateSession(harness.db, token, clock)).not.toBeNull();
    }
    now = new Date(baseTime.getTime() + ABSOLUTE_MS);
    expect(await validateSession(harness.db, token, clock)).toBeNull();
  });
  it("ignores malformed cookies and uses secure flags based on APP_URL", async () => {
    expect(await validateSession(harness.db, "bad", clock)).toBeNull();
    expect(await validateSession(harness.db, undefined, clock)).toBeNull();
    expect(sessionCookieOptions("https://ledger.example.com")).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    });
    expect(sessionCookieOptions("http://localhost:3000").secure).toBe(false);
  });
});
describe("rate limit", () => {
  it("locks at 5 failures by either email or IP and resets after the window", async () => {
    const keys = rateKeys("owner@example.com", "192.0.2.1", secret);
    for (let i = 0; i < 5; i++) await limitedAttempt(harness.db, keys, async () => ({ ok: false }), clock);
    await expect(
      assertRateLimit(harness.db, rateKeys("owner@example.com", "192.0.2.2", secret), clock),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      assertRateLimit(harness.db, rateKeys("other@example.com", "192.0.2.1", secret), clock),
    ).rejects.toMatchObject({ status: 429 });
    await expect(limitedAttempt(harness.db, keys, async () => ({ ok: true }), clock)).rejects.toMatchObject({
      status: 429,
    });
    expect((await harness.db.select().from(loginAttempts)).every((row) => !row.keyHash.includes("@"))).toBe(
      true,
    );
    now = new Date(baseTime.getTime() + RATE_WINDOW_MS);
    await expect(assertRateLimit(harness.db, keys, clock)).resolves.toBeUndefined();
  });
  it("successful attempts do not count as failures", async () => {
    const keys = rateKeys("owner@example.com", "ip", secret);
    for (let i = 0; i < 6; i++) await recordAttempt(harness.db, keys, true, clock);
    await expect(assertRateLimit(harness.db, keys, clock)).resolves.toBeUndefined();
  });
  it("trusts only opted-in valid Cloudflare IPs", () => {
    const headers = new Headers({ "cf-connecting-ip": "192.0.2.1", "x-forwarded-for": "192.0.2.2" });
    expect(clientIp(headers, false)).toBe("untrusted-client");
    expect(clientIp(headers, true)).toBe("192.0.2.1");
    expect(clientIp(new Headers({ "x-forwarded-for": "192.0.2.2" }), true)).toBe("untrusted-client");
  });
});
describe("TOTP", () => {
  it("keeps pending enrollment encrypted and only enables with valid code", async () => {
    const setup = await startTotpEnrollment(harness.db, userId, secret, clock);
    const [pending] = await harness.db.select().from(users);
    expect(pending.totpEnabledAt).toBeNull();
    expect(pending.totpPendingSecretEnc).not.toContain(setup.secret);
    expect(await enableTotp(harness.db, userId, "wrong!", secret, clock)).toBe(false);
    expect(
      await enableTotp(
        harness.db,
        userId,
        makeTotp(setup.secret).generate({ timestamp: now.getTime() }),
        secret,
        clock,
      ),
    ).toBe(true);
    const [active] = await harness.db.select().from(users);
    expect(decryptSecret(active.totpSecretEnc!, secret)).toBe(setup.secret);
    expect(active.totpPendingSecretEnc).toBeNull();
    expect(await harness.db.select().from(auditLogs)).toHaveLength(1);
  });
  it("expires pending setup after ten minutes", async () => {
    const setup = await startTotpEnrollment(harness.db, userId, secret, clock);
    now = new Date(baseTime.getTime() + 600000);
    expect(
      await enableTotp(
        harness.db,
        userId,
        makeTotp(setup.secret).generate({ timestamp: now.getTime() }),
        secret,
        clock,
      ),
    ).toBe(false);
  });
  it("accepts ±1 step and rejects out-of-window or malformed codes", () => {
    const otpSecret = "JBSWY3DPEHPK3PXP";
    for (const delta of [-1, 0, 1])
      expect(
        verifyTotp(
          otpSecret,
          makeTotp(otpSecret).generate({ timestamp: now.getTime() + delta * 30000 }),
          now,
        ),
      ).toBe(BigInt(now.getTime() / 30000 + delta));
    expect(
      verifyTotp(otpSecret, makeTotp(otpSecret).generate({ timestamp: now.getTime() + 60000 }), now),
    ).toBeNull();
    expect(verifyTotp(otpSecret, "wrong!", now)).toBeNull();
  });
  it("rejects reuse of an accepted counter and invalid disable, revokes sessions on disable", async () => {
    const otpSecret = await enrolled();
    await createSession(harness.db, userId, metadata, clock);
    const code = makeTotp(otpSecret).generate({ timestamp: now.getTime() });
    expect(await consumeTotp(harness.db, userId, code, secret, clock)).toBe(true);
    expect(await consumeTotp(harness.db, userId, code, secret, clock)).toBe(false);
    expect(await disableTotp(harness.db, userId, code, secret, clock)).toBe(false);
    now = new Date(now.getTime() + 30000);
    expect(
      await disableTotp(
        harness.db,
        userId,
        makeTotp(otpSecret).generate({ timestamp: now.getTime() }),
        secret,
        clock,
      ),
    ).toBe(true);
    expect((await harness.db.select().from(users))[0].totpSecretEnc).toBeNull();
    expect(await harness.db.select().from(sessions)).toHaveLength(0);
  });
});
describe("login and bootstrap", () => {
  it("does not issue sessions before both factors and rejects replay", async () => {
    const otpSecret = await enrolled();
    expect(await loginPassword(harness.db, "owner@example.com", "incorrect", context, clock)).toEqual({
      ok: false,
    });
    const first = await loginPassword(harness.db, "OWNER@example.com", password, context, clock);
    expect(await harness.db.select().from(sessions)).toHaveLength(0);
    if (!first.ok || !("challenge" in first)) throw new Error("expected challenge");
    const code = makeTotp(otpSecret).generate({ timestamp: now.getTime() });
    const second = await loginTotp(harness.db, first.challenge, code, context, clock);
    expect(second).toHaveProperty("token");
    expect(await loginTotp(harness.db, first.challenge, code, context, clock)).toEqual({ ok: false });
    expect(await harness.db.select().from(sessions)).toHaveLength(1);
  });
  it("rejects expired, altered, wrong-IP and password-invalidated challenges", async () => {
    const otpSecret = await enrolled();
    const first = await loginPassword(harness.db, "owner@example.com", password, context, clock);
    if (!first.ok || !("challenge" in first)) throw new Error("expected challenge");
    const code = makeTotp(otpSecret).generate({ timestamp: now.getTime() });
    expect(
      await loginTotp(harness.db, first.challenge, code, { ...context, ip: "192.0.2.1" }, clock),
    ).toEqual({ ok: false });
    expect(await loginTotp(harness.db, "invalid", code, context, clock)).toEqual({ ok: false });
    await harness.db.update(users).set({ passwordHash: "changed" }).where(eq(users.id, userId));
    expect(await loginTotp(harness.db, first.challenge, code, context, clock)).toEqual({ ok: false });
    now = new Date(now.getTime() + 300000);
    expect(await loginTotp(harness.db, first.challenge, code, context, clock)).toEqual({ ok: false });
    expect(await harness.db.select().from(sessions)).toHaveLength(0);
  });
  it("rotates password-only login session", async () => {
    const old = await createSession(harness.db, userId, metadata, clock);
    const result = await loginPassword(
      harness.db,
      "owner@example.com",
      password,
      { ...context, oldToken: old.token },
      clock,
    );
    expect(result).toHaveProperty("token");
    expect(await validateSession(harness.db, old.token, clock)).toBeNull();
  });
  it("bootstrap is a no-op with existing users and rejects weak passwords", async () => {
    const input = {
      email: "demo@example.com",
      password,
      baseCurrency: "USD",
      timezone: "America/Los_Angeles",
    };
    expect(await createAdmin(harness.db, input, true)).toBeNull();
    await expect(createAdmin(harness.db, { ...input, password: "short" })).rejects.toThrow("12");
    await harness.db.execute(sql`truncate audit_logs, users cascade`);
    const user = await createAdmin(harness.db, input, true);
    expect(user?.id).toBeTruthy();
    expect(await createAdmin(harness.db, input, true)).toBeNull();
  });
});
it("real migrations applied twice are a no-op without changing data", async () => {
  const before = await harness.db.select().from(users);
  await harness.applyMigrations();
  expect(await harness.db.select().from(users)).toEqual(before);
  expect(
    (
      await harness.client.query<{ count: number }>(
        "select count(*)::int as count from drizzle.__drizzle_migrations",
      )
    ).rows[0].count,
  ).toBe(22);
});
