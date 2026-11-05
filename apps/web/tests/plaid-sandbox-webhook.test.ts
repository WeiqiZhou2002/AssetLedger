import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { auditLogs, bankConnections, plaidSettings, users } from "@/db/schema";
import { encryptSecret } from "@/lib/auth/crypto";
import type { PlaidConfig } from "@/lib/bank-sync/types";
import { createTestDb } from "./helpers/db";
import { plaidConfig } from "./helpers/plaid";

const sdk = vi.hoisted(() => ({ fire: vi.fn(), construct: vi.fn() }));
const pool = vi.hoisted(() => ({ end: vi.fn() }));
// CLI imports must never load local environment files or connect to the owner's database.
vi.mock("../scripts/env", () => ({}));
vi.mock("@/db/client", () => ({ getDb: () => h.db, getPool: () => pool }));
vi.mock("@/lib/env", () => ({ readEnv: () => config }));
vi.mock("plaid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("plaid")>()),
  PlaidApi: class {
    constructor(...args: unknown[]) {
      sdk.construct(...args);
      return { sandboxItemFireWebhook: sdk.fire };
    }
  },
}));

let h: Awaited<ReturnType<typeof createTestDb>>;
let config: PlaidConfig;
let ownerId: string;
let otherId: string;
let connectionId: string;
let output = vi.fn();
let errors = vi.fn();
const accessToken = "access-sandbox-synthetic-webhook-test";
const ownerEmail = "synthetic-owner@example.test";
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const failure = { error_code: "PLAID_REQUEST_FAILED", request_id: null };

async function run(...args: string[]) {
  process.argv = ["node", "plaid-sandbox-webhook.cjs", "--owner", ownerEmail.toUpperCase(), ...args];
  await import("../scripts/plaid-sandbox-webhook");
  await vi.waitFor(() => expect(pool.end).toHaveBeenCalledOnce());
}
const fire = () => run("--connection", connectionId, "--fire");
const update = (changes: Partial<typeof bankConnections.$inferInsert>) =>
  h.db.update(bankConnections).set(changes).where(eq(bankConnections.id, connectionId));
const logs = () => h.db.select().from(auditLogs);

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.client.close();
});
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  config = { ...plaidConfig };
  pool.end.mockResolvedValue(undefined);
  sdk.fire.mockResolvedValue({ data: { webhook_fired: true, request_id: "synthetic-request" } });
  output = vi.fn();
  errors = vi.fn();
  vi.spyOn(console, "log").mockImplementation(output);
  vi.spyOn(console, "error").mockImplementation(errors);
  process.exitCode = 0;
  await h.db.execute(sql`truncate users cascade`);
  const owners = await h.db
    .insert(users)
    .values([
      { email: ownerEmail, passwordHash: "synthetic-unused-hash" },
      { email: "synthetic-other@example.test", passwordHash: "synthetic-unused-hash" },
    ])
    .returning();
  [ownerId, otherId] = owners.map((owner) => owner.id);
  const [connection] = await h.db
    .insert(bankConnections)
    .values({
      ownerId,
      environment: "sandbox",
      plaidItemId: "synthetic-linked-item",
      institutionName: "Example Sandbox Bank",
      accessTokenEnc: encryptSecret(accessToken, config.APP_SECRET, "plaid-access-token"),
      importFromDate: "2026-11-01",
      webhookUrl: "http://localhost:3000/api/plaid/webhook",
    })
    .returning();
  connectionId = connection.id;
});
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

it.each(["sandbox", "production"] as const)(
  "lists only the owner's current %s connections without secrets or Plaid calls, even when disabled",
  async (environment) => {
    config = { ...config, PLAID_ENV: environment, PLAID_ENABLED: "false" };
    await update({ environment, status: "revoked", webhookUrl: null, newAccountsAvailableAt: new Date() });
    await h.db.insert(bankConnections).values(
      [
        { ownerId, environment: environment === "sandbox" ? "production" : "sandbox" } as const,
        { ownerId: otherId, environment },
      ].map((row) => ({
        ...row,
        plaidItemId: "synthetic-excluded-item",
        institutionName: "Example Excluded Bank",
        accessTokenEnc: "synthetic-unreadable-ciphertext",
        importFromDate: "2026-11-01",
      })),
    );
    await run();
    expect(output.mock.calls).toEqual([
      [
        JSON.stringify({
          connections: [
            {
              id: connectionId,
              institutionName: "Example Sandbox Bank",
              status: "revoked",
              webhookRegistered: false,
              newAccountsPending: true,
            },
          ],
        }),
      ],
    ]);
    expect(sdk.construct).not.toHaveBeenCalled();
    expect(sdk.fire).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(await logs()).toEqual([]);
  },
);

it.each(["production config", "disabled config", "production connection", "revoked connection"])(
  "refuses %s without a Plaid call or audit",
  async (scenario) => {
    if (scenario === "production config") config.PLAID_ENV = "production";
    if (scenario === "disabled config") config.PLAID_ENABLED = "false";
    if (scenario === "production connection") await update({ environment: "production" });
    if (scenario === "revoked connection") await update({ status: "revoked" });
    await fire();
    expect(errors.mock.calls).toEqual([["仅允许 Sandbox；未发出任何请求"]]);
    expect(output).not.toHaveBeenCalled();
    expect(sdk.construct).not.toHaveBeenCalled();
    expect(sdk.fire).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(await logs()).toEqual([]);
  },
);

it("refuses an unregistered webhook and tells the owner to sync first", async () => {
  await update({ webhookUrl: null });
  await fire();
  expect(errors.mock.calls).toEqual([["先在应用中点「立即同步」登记通知地址，再触发"]]);
  expect(sdk.construct).not.toHaveBeenCalled();
  expect(sdk.fire).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
  expect(await logs()).toEqual([]);
});

it.each(["unknown", "other owner"])("refuses a connection belonging to %s safely", async (scenario) => {
  if (scenario === "unknown") connectionId = crypto.randomUUID();
  else await update({ ownerId: otherId });
  await fire();
  // Same message either way, so another owner's connection is indistinguishable from a missing one.
  expect(errors.mock.calls).toEqual([["银行连接不存在"]]);
  expect(sdk.construct).not.toHaveBeenCalled();
  expect(sdk.fire).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
  expect(await logs()).toEqual([]);
});

it("uses the owner's resolved Sandbox settings, decrypts the token, fires ITEM and audits only IDs", async () => {
  config = {
    ...config,
    PLAID_ENABLED: "false",
    PLAID_ENV: "production",
    PLAID_CLIENT_ID: "",
    PLAID_SECRET: "",
  };
  await h.db.insert(plaidSettings).values({
    ownerId,
    environment: "sandbox",
    enabled: true,
    clientId: "synthetic-settings-client",
    secretEnc: encryptSecret("synthetic-settings-secret", config.APP_SECRET, "plaid-secret"),
    verifiedAt: new Date(),
  });
  await fire();
  expect(sdk.fire).toHaveBeenCalledExactlyOnceWith({
    access_token: accessToken,
    webhook_type: "ITEM",
    webhook_code: "NEW_ACCOUNTS_AVAILABLE",
  });
  expect(output.mock.calls).toEqual([
    [JSON.stringify({ webhook_fired: true })],
    ["公网可达的 HTTPS 安装会实时收到提醒，刷新页面即可；HTTP 安装请点「立即同步」查询通知记录。"],
  ]);
  expect(errors).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(0);
  const audit = await logs();
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    ownerId,
    actorUserId: ownerId,
    entityType: "bank_connection",
    entityId: connectionId,
    action: "bank.sandbox_webhook_fired",
    changes: {},
  });
  const [connection] = await h.db.select().from(bankConnections).where(eq(bankConnections.id, connectionId));
  expect(connection.newAccountsAvailableAt).toBeNull();
  expect(connection.accessTokenEnc).not.toContain(accessToken);
  for (const secret of [
    accessToken,
    config.APP_SECRET,
    "synthetic-settings-secret",
    connection.accessTokenEnc,
  ])
    expect(JSON.stringify([output.mock.calls, errors.mock.calls, audit])).not.toContain(secret);
});

it.each([
  { error_code: "SANDBOX_ACCOUNT_SELECT_V2_NOT_ENABLED", request_id: "synthetic-request" },
  { error_code: "unsafe synthetic secret", request_id: "unsafe synthetic secret" },
])("prints only safe Plaid error fields: $error_code", async (error) => {
  sdk.fire.mockRejectedValue({
    config: { headers: { secret: "synthetic-secret" }, data: { access_token: accessToken } },
    response: { data: { ...error, error_message: "synthetic-private-provider-message" } },
  });
  await fire();
  expect(errors.mock.calls).toEqual([
    [JSON.stringify(error.error_code.startsWith("SANDBOX_") ? error : failure)],
  ]);
  expect(output).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
  expect(await logs()).toEqual([]);
});

it("does not report or audit a false webhook_fired response as success", async () => {
  sdk.fire.mockResolvedValue({ data: { webhook_fired: false, request_id: "synthetic-request" } });
  await fire();
  expect(errors.mock.calls).toEqual([
    [JSON.stringify({ error_code: "SANDBOX_WEBHOOK_NOT_FIRED", request_id: "synthetic-request" })],
  ]);
  expect(output).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
  expect(await logs()).toEqual([]);
});

it("allows revocation during the Plaid call and skips the success audit afterwards", async () => {
  sdk.fire.mockImplementation(async () => {
    await update({ status: "revoked" });
    return { data: { webhook_fired: true } };
  });
  await fire();
  expect(sdk.fire).toHaveBeenCalledOnce();
  expect(errors).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(0);
  expect(await logs()).toEqual([]);
});
