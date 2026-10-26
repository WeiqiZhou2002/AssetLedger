import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { setupTokens, users } from "@/db/schema";
import { createTestDb } from "./helpers/db";

const pool = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn() }));
vi.mock("@/db/client", () => ({ getPool: () => pool }));
// Never load the owner's local environment in CLI tests.
vi.mock("../scripts/env", () => ({}));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: () => harness.db }));

let harness: Awaited<ReturnType<typeof createTestDb>>;
const originalArgv = process.argv;
const originalExitCode = process.exitCode;

beforeAll(async () => {
  harness = await createTestDb();
});
afterAll(async () => {
  await harness.client.close();
});
beforeEach(async () => {
  vi.resetModules();
  pool.query.mockReset().mockImplementation((query: string) => harness.client.query(query));
  pool.end.mockReset().mockResolvedValue(undefined);
  await harness.db.execute(sql`truncate users, setup_tokens cascade`);
  vi.stubEnv("ADMIN_EMAIL", undefined);
  vi.stubEnv("ADMIN_PASSWORD", undefined);
  process.argv = ["node", "admin.cjs", "--status"];
});
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "reports hasUsers=%s as exactly one JSON line without credentials",
  async (hasUsers) => {
    if (hasUsers) {
      await harness.db.insert(users).values({
        email: "synthetic-admin@example.com",
        passwordHash: "synthetic-unused-hash",
      });
    }
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await import("../scripts/admin");
    await vi.waitFor(() => expect(pool.end).toHaveBeenCalledOnce());
    expect(output.mock.calls).toEqual([[JSON.stringify({ kind: "admin_status", hasUsers })]]);
    expect(errors).not.toHaveBeenCalled();
    expect(await harness.db.select({ id: users.id }).from(users)).toHaveLength(hasUsers ? 1 : 0);
  },
);

it("closes the pool and fails without leaking database errors or reporting an empty database", async () => {
  pool.query.mockRejectedValue(new Error("synthetic-secret-database-error"));
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await import("../scripts/admin");
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(pool.end).toHaveBeenCalledOnce();
  expect(output).not.toHaveBeenCalled();
  expect(errors.mock.calls).toEqual([["创建管理员失败：检查邮箱、至少 12 位的密码、环境配置及数据库连接。"]]);
});

it("prints setup-link JSON only on explicit invocation and rotates hash-only storage", async () => {
  process.argv = ["node", "admin.cjs", "--setup-link"];
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const { hashToken } = await import("@/lib/auth/crypto");
  await import("../scripts/admin");
  await vi.waitFor(() => expect(pool.end).toHaveBeenCalledOnce());
  const first = JSON.parse(output.mock.calls[0][0] as string);
  expect(first).toEqual({ kind: "setup_link", path: expect.stringMatching(/^\/setup\?token=[\w-]{43}$/) });
  const firstToken = first.path.split("=")[1];
  expect((await harness.db.select().from(setupTokens))[0].tokenHash).toBe(hashToken(firstToken));
  vi.resetModules();
  pool.end.mockClear();
  output.mockClear();
  await import("../scripts/admin");
  await vi.waitFor(() => expect(pool.end).toHaveBeenCalledOnce());
  expect(output).toHaveBeenCalledOnce();
  const second = JSON.parse(output.mock.calls[0][0] as string);
  expect(second.path).not.toBe(first.path);
  const rows = await harness.db.select().from(setupTokens);
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain(firstToken);
  expect(rows[0].tokenHash).toBe(hashToken(second.path.split("=")[1]));
  await harness.db.insert(users).values({ email: "synthetic-existing@example.com", passwordHash: "unused" });
  vi.resetModules();
  pool.end.mockClear();
  output.mockClear();
  await import("../scripts/admin");
  await vi.waitFor(() => expect(pool.end).toHaveBeenCalledOnce());
  expect(output.mock.calls).toEqual([[JSON.stringify({ kind: "setup_not_needed" })]]);
  expect(errors).not.toHaveBeenCalled();
});
