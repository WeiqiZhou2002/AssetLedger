import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { users } from "@/db/schema";
import { createTestDb } from "./helpers/db";

const pool = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn() }));
vi.mock("@/db/client", () => ({ getPool: () => pool }));
// Never load the owner's local environment in CLI tests.
vi.mock("../scripts/env", () => ({}));

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
  await harness.db.execute(sql`truncate users cascade`);
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
