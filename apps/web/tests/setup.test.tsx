import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestDb } from "./helpers/db";
import { auditLogs, loginAttempts, sessions, setupTokens, users } from "@/db/schema";
import { completeSetup, createSetupLink, hasUsers, validSetupToken } from "@/lib/auth/setup";
import { hashToken } from "@/lib/auth/crypto";
import { validateSession } from "@/lib/auth/session";
import { verifyPassword } from "@/lib/auth/password";
import { proxy } from "@/proxy";
let h: Awaited<ReturnType<typeof createTestDb>>;
const now = new Date("2026-10-26T12:00:00Z");
const clock = () => now;
const context = {
  appSecret: "synthetic-setup-secret-at-least-32-characters",
  ip: "untrusted-client",
  userAgent: "synthetic-setup-test",
  baseCurrency: "USD",
  timezone: "America/Los_Angeles",
};
const input = {
  email: "setup-owner@example.com",
  password: "synthetic-new-password",
  confirmPassword: "synthetic-new-password",
};
vi.mock("@/db/client", () => ({ getDb: () => h.db }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));
const api = await import("@/app/api/setup/route");
const Setup = (await import("@/app/(auth)/setup/page")).default;
const Login = (await import("@/app/(auth)/login/page")).default;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.client.close();
  vi.unstubAllEnvs();
});
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await h.db.execute(sql`truncate users, setup_tokens, login_attempts cascade`);
  vi.stubEnv("APP_SECRET", context.appSecret);
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic/test");
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("PLAID_CLIENT_ID", "");
  vi.stubEnv("PLAID_SECRET", "");
});
async function token(at = clock) {
  const result = await createSetupLink(h.db, at);
  if (result.kind !== "setup_link") throw new Error("expected setup link");
  return result.path.split("=")[1];
}
const request = (body: unknown, origin = "http://localhost:3000") =>
  new NextRequest("http://localhost:3000/api/setup", {
    method: "POST",
    headers: { host: "localhost:3000", origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
it("stores only a SHA256 hash, expires at 24 hours and rotates earlier links", async () => {
  const first = await token();
  expect(first).toMatch(/^[\w-]{43}$/);
  const [row] = await h.db.select().from(setupTokens);
  expect(row.tokenHash).toBe(hashToken(first));
  expect(JSON.stringify(row)).not.toContain(first);
  expect(row.expiresAt.getTime()).toBe(now.getTime() + 86400000);
  expect(await validSetupToken(h.db, first, new Date(row.expiresAt.getTime() - 1))).toEqual({ id: row.id });
  expect(await validSetupToken(h.db, first, row.expiresAt)).toBeNull();
  const second = await token();
  expect(second).not.toBe(first);
  expect(await validSetupToken(h.db, first, now)).toBeNull();
  expect(await h.db.select().from(setupTokens)).toHaveLength(1);
});
it("rejects invalid/expired links and mismatched or invalid passwords without creating a user", async () => {
  const expired = await token(() => new Date(now.getTime() - 86400000));
  for (const value of [expired, "z".repeat(43)]) {
    expect(await completeSetup(h.db, { ...input, token: value }, context, clock)).toMatchObject({
      ok: false,
      status: 400,
      error: "设置链接无效或已过期",
    });
  }
  const good = await token();
  for (const change of [
    { confirmPassword: "different-password" },
    { password: "short" },
    { password: "x".repeat(1025) },
  ]) {
    expect(await completeSetup(h.db, { ...input, ...change, token: good }, context, clock)).toMatchObject({
      ok: false,
      status: 400,
    });
  }
  expect(await hasUsers(h.db)).toBe(false);
  expect(await validSetupToken(h.db, good, now)).not.toBeNull();
  expect(await h.db.select().from(loginAttempts)).toHaveLength(5);
});
it.each([undefined, "invalid"])(
  "rejects missing or malformed setup token %s with the recovery message",
  async (value) => {
    const response = await api.POST(request({ ...input, token: value }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "设置链接无效或已过期" });
  },
);
it("serializes concurrent submissions to exactly one admin and consumes the token", async () => {
  const value = await token();
  const results = await Promise.all([
    completeSetup(h.db, { ...input, token: value }, context, clock),
    completeSetup(h.db, { ...input, token: value }, { ...context, ip: "other-synthetic-ip" }, clock),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)).toMatchObject({ status: 409 });
  expect(await h.db.select().from(users)).toHaveLength(1);
  expect(await h.db.select().from(sessions)).toHaveLength(1);
  expect(await h.db.select().from(setupTokens)).toHaveLength(0);
  expect(await validSetupToken(h.db, value, now)).toBeNull();
  expect(await createSetupLink(h.db, clock)).toEqual({ kind: "setup_not_needed" });
});
it("sets a login session cookie, hashes the password, and never logs/audits setup or session tokens", async () => {
  const logs = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "info").mockImplementation(() => {}),
  ];
  const value = await token(() => new Date());
  const response = await api.POST(request({ ...input, token: value }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  const cookie = response.cookies.get("al_session")!;
  expect(cookie.value).toMatch(/^[\w-]{43}$/);
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe("lax");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await validateSession(h.db, cookie.value)).not.toBeNull();
  const [user] = await h.db.select().from(users);
  expect(await verifyPassword(user.passwordHash, input.password)).toBe(true);
  const audit = await h.db.select().from(auditLogs);
  expect(audit.map((row) => row.action)).toEqual(["user.bootstrap", "setup.completed"]);
  expect(audit.every((row) => row.entityId === user.id && Object.keys(row.changes).length === 0)).toBe(true);
  for (const secret of [value, cookie.value, input.password])
    expect(JSON.stringify(audit)).not.toContain(secret);
  expect(logs.every((log) => log.mock.calls.length === 0)).toBe(true);
  expect((await api.POST(request({ ...input, token: value }))).status).toBe(409);
  await expect(Setup({ searchParams: Promise.resolve({ token: value }) })).rejects.toThrow("redirect:/login");
});
it("checks origin and rate limits invalid tokens by IP even when email changes", async () => {
  const value = await token(() => new Date());
  expect((await api.POST(request({ ...input, token: value }, "https://evil.example"))).status).toBe(403);
  for (let i = 0; i < 5; i++)
    expect(
      (await api.POST(request({ ...input, email: `synthetic-${i}@example.com`, token: "x".repeat(43) })))
        .status,
    ).toBe(400);
  const blocked = await api.POST(request({ ...input, token: value }));
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get("retry-after")).toBe("900");
  expect(await hasUsers(h.db)).toBe(false);
});
it("rolls back token consumption when admin/session persistence fails", async () => {
  const value = await token();
  await h.db.execute(sql`alter table sessions add constraint synthetic_session_failure check (false)`);
  try {
    await expect(completeSetup(h.db, { ...input, token: value }, context, clock)).rejects.toThrow();
  } finally {
    await h.db.execute(sql`alter table sessions drop constraint synthetic_session_failure`);
  }
  expect(await hasUsers(h.db)).toBe(false);
  expect(await validSetupToken(h.db, value, now)).not.toBeNull();
  expect(await h.db.select().from(auditLogs)).toHaveLength(0);
});
it("renders invalid-link recovery and first-run login hint without publishing a token", async () => {
  const value = await token(() => new Date());
  const hint = renderToStaticMarkup(await Login());
  expect(hint).toContain("尚未完成首次设置");
  expect(hint).toContain("scripts/setup.sh");
  expect(hint).not.toContain(value);
  const invalid = renderToStaticMarkup(await Setup({ searchParams: Promise.resolve({ token: "invalid" }) }));
  expect(invalid).toContain("设置链接无效或已过期");
  expect(invalid).toContain("--setup-link");
  const form = renderToStaticMarkup(await Setup({ searchParams: Promise.resolve({ token: value }) }));
  expect(form).toContain("确认密码");
  expect(form).toContain('minLength="12"');
  expect(form).not.toContain(value);
  await completeSetup(h.db, { ...input, token: value }, context);
  expect(renderToStaticMarkup(await Login())).not.toContain("尚未完成首次设置");
});
it("allows only the setup entry point unauthenticated and keeps a strict exact-host CSP", () => {
  for (const path of ["/setup?token=synthetic", "/api/setup"])
    expect(proxy(new NextRequest(`http://localhost:3000${path}`)).status).toBe(200);
  for (const path of ["/setup/next", "/setup-other", "/dashboard"])
    expect(proxy(new NextRequest(`http://localhost:3000${path}`)).headers.get("location")).toBe(
      "http://localhost:3000/login",
    );
  const response = proxy(new NextRequest("http://localhost:3000/setup"));
  const csp = response.headers.get("content-security-policy")!;
  expect(csp).toContain("'strict-dynamic'");
  expect(csp).toContain("'nonce-");
  expect(csp.split("; ").find((value) => value.startsWith("connect-src"))).toBe(
    "connect-src 'self' https://production.plaid.com https://sandbox.plaid.com",
  );
  expect(csp.split("; ").find((value) => value.startsWith("frame-src"))).toBe(
    "frame-src https://cdn.plaid.com/",
  );
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
});
