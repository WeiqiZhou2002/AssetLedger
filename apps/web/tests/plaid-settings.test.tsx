import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "./helpers/db";
import { FakePlaid, plaidConfig, plaidFailure } from "./helpers/plaid";
import { auditLogs, bankConnections, importJobs, plaidSettings, users } from "@/db/schema";
import { loadPlaidConfig } from "@/lib/bank-sync/config";
import { connectionEnvironments, publicPlaidSettings, savePlaidSettings } from "@/lib/bank-sync/settings";
import { scheduleSyncs } from "@/lib/bank-sync/connections";
import { processConfiguredBankJob } from "@/lib/bank-sync/jobs";
import { claimJob } from "@/lib/imports/jobs";
import { decryptSecret, encryptSecret } from "@/lib/auth/crypto";
import { createSession } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { exportOwnerCsv, exportOwnerData } from "@/lib/data/export";
import { deleteOwnerData, DELETE_CONFIRMATION } from "@/lib/data/delete";
import { PlaidSettingsForm } from "@/components/bank-sync/settings-form";

let h: Awaited<ReturnType<typeof createTestDb>>;
let ownerId: string;
let otherId: string;
const emptyEnv = { ...plaidConfig, PLAID_CLIENT_ID: "", PLAID_SECRET: "" };
const draft = {
  environment: "sandbox" as const,
  clientId: "synthetic-settings-client",
  secret: "synthetic-settings-secret",
  enabled: false,
  redirectUri: "",
};
const verify = vi.hoisted(() => vi.fn());
vi.mock("@/db/client", () => ({ getDb: () => h.db }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/bank-sync/plaid-client", async (original) => ({
  ...(await original<typeof import("@/lib/bank-sync/plaid-client")>()),
  testPlaidCredentials: verify,
}));
const api = await import("@/app/api/plaid/settings/route");
const testApi = await import("@/app/api/plaid/settings/test/route");
const environmentsApi = await import("@/app/api/plaid/settings/environments/route");
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.client.close();
  vi.unstubAllEnvs();
});
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await h.db.execute(sql`truncate users cascade`);
  const rows = await h.db
    .insert(users)
    .values([
      { email: "plaid-owner@example.com", passwordHash: "unused" },
      { email: "plaid-other@example.com", passwordHash: "unused" },
    ])
    .returning();
  [ownerId, otherId] = rows.map((row) => row.id);
  for (const [key, value] of Object.entries(emptyEnv)) vi.stubEnv(key, String(value));
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic/test");
  vi.stubEnv("APP_URL", "http://localhost:3000");
  verify.mockReset().mockResolvedValue(undefined);
});
const save = (input = draft, owner = ownerId, test = false) =>
  savePlaidSettings(h.db, owner, input, emptyEnv, test, verify);
async function request(
  method: string,
  owner: string | null = ownerId,
  body?: unknown,
  origin = "http://localhost:3000",
) {
  const session = owner
    ? await createSession(h.db, owner, { ipHash: "synthetic", userAgent: "settings-test" })
    : null;
  return new NextRequest("http://localhost:3000/api/plaid/settings", {
    method,
    headers: {
      host: "localhost:3000",
      origin,
      "content-type": "application/json",
      ...(session ? { cookie: `al_session=${session.token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function connection(
  owner: string,
  environment: "sandbox" | "production",
  status: "active" | "revoked" = "active",
) {
  const [row] = await h.db
    .insert(bankConnections)
    .values({
      ownerId: owner,
      environment,
      institutionName: "Example Bank",
      plaidItemId: `synthetic-${owner}-${environment}`,
      accessTokenEnc: encryptSecret("synthetic-item-token", emptyEnv.APP_SECRET, "plaid-access-token"),
      products: ["transactions"],
      status,
      mappingConfirmedAt: new Date("2026-01-01"),
      importFromDate: "2026-01-01",
      daysRequested: 90,
    })
    .returning();
  return row;
}
it("resolves env > owner settings > none, including env disable and partial keys", async () => {
  expect(await loadPlaidConfig(h.db, ownerId, emptyEnv)).toMatchObject({
    source: "none",
    config: { PLAID_ENABLED: "false", PLAID_SECRET: "" },
  });
  await save({ ...draft, enabled: true }, ownerId, true);
  expect(await loadPlaidConfig(h.db, ownerId, { ...emptyEnv, PLAID_CLIENT_ID: "partial" })).toMatchObject({
    source: "settings",
    config: {
      PLAID_SECRET: draft.secret,
      PLAID_ENABLED: "true",
      PLAID_DAYS_REQUESTED: 90,
      APP_SECRET: emptyEnv.APP_SECRET,
    },
  });
  const env = {
    ...plaidConfig,
    PLAID_ENABLED: "false" as const,
    PLAID_ENV: "production" as const,
    PLAID_REDIRECT_URI: "https://example.com/plaid/oauth",
  };
  expect(await loadPlaidConfig(h.db, ownerId, env)).toEqual({ source: "env", config: env });
  expect((await loadPlaidConfig(h.db, otherId, emptyEnv)).source).toBe("none");
  await expect(savePlaidSettings(h.db, ownerId, draft, env)).rejects.toThrow("环境变量管理");
});
it("requires successful verification to enable, retains blank secrets, invalidates changed credentials", async () => {
  await expect(save({ ...draft, enabled: true })).rejects.toThrow("成功测试");
  const tested = await save({ ...draft, enabled: true }, ownerId, true);
  expect(tested.verifiedAt).toBeTruthy();
  expect(verify).toHaveBeenCalledOnce();
  expect((await save({ ...draft, secret: "", enabled: true })).verifiedAt).toBe(tested.verifiedAt);
  expect((await loadPlaidConfig(h.db, ownerId, emptyEnv)).config.PLAID_SECRET).toBe(draft.secret);
  await expect(save({ ...draft, secret: "synthetic-new-secret", enabled: true })).rejects.toThrow("成功测试");
  expect((await save({ ...draft, clientId: "synthetic-new-client" })).verifiedAt).toBeNull();
  await expect(save({ ...draft, redirectUri: "javascript:alert(1)" })).rejects.toThrow();
});
it.each([
  ["INVALID_API_KEYS", 400, "Client ID 或 Secret 不正确"],
  ["INVALID_FIELD", 400, "Client ID 或 Secret 不正确"],
  ["INVALID_ENVIRONMENT", 400, "环境不匹配"],
  ["UNAUTHORIZED_ENVIRONMENT", 400, "环境不匹配"],
  ["RATE_LIMIT_EXCEEDED", 502, "错误码 RATE_LIMIT_EXCEEDED"],
  ["network", 502, "检查网络"],
])("maps %s without leaking SDK errors or persisting untested drafts", async (code, status, message) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  verify.mockRejectedValue(
    code === "network"
      ? new Error(draft.secret)
      : { ...plaidFailure(code), config: { secret: draft.secret } },
  );
  const response = await testApi.POST(await request("POST", ownerId, { ...draft, enabled: true }));
  expect(response.status).toBe(status);
  expect(await response.text()).toContain(message);
  expect(await h.db.select().from(plaidSettings)).toHaveLength(0);
  expect(log).not.toHaveBeenCalled();
});
it("GET/export/audit and server-rendered form never disclose the encrypted or plaintext secret", async () => {
  const response = await testApi.POST(await request("POST", ownerId, draft));
  expect(response.status).toBe(200);
  const [row] = await h.db.select().from(plaidSettings);
  expect(row.secretEnc).not.toContain(draft.secret);
  expect(decryptSecret(row.secretEnc, emptyEnv.APP_SECRET, "plaid-secret")).toBe(draft.secret);
  expect(() => decryptSecret(row.secretEnc, emptyEnv.APP_SECRET, "plaid-access-token")).toThrow();
  const safe = await (await api.GET(await request("GET"))).json();
  expect(Object.keys(safe).sort()).toEqual(
    ["source", "environment", "clientId", "hasSecret", "redirectUri", "enabled", "verifiedAt"].sort(),
  );
  const logs = await h.db.select().from(auditLogs);
  expect(logs.map((row) => row.action)).toEqual(["plaid.settings.updated", "plaid.settings.verified"]);
  expect(logs.every((log) => log.entityId === row.id && Object.keys(log.changes).length === 0)).toBe(true);
  const exported = JSON.stringify(await exportOwnerData(h.db, ownerId));
  const csv = await exportOwnerCsv(h.db, ownerId, "plaid_settings");
  const html = renderToStaticMarkup(
    <PlaidSettingsForm initial={safe} environments={[]} callbackUrl="http://localhost:3000/plaid/oauth" />,
  );
  for (const text of [JSON.stringify(safe), exported, csv, JSON.stringify(logs), html]) {
    expect(text).not.toContain(draft.secret);
    expect(text).not.toContain(row.secretEnc);
    expect(text).not.toContain("secretEnc");
  }
  expect(html).toContain("已保存");
  expect(html).toContain('type="password"');
  expect(
    renderToStaticMarkup(
      <PlaidSettingsForm initial={{ ...safe, source: "env" }} environments={[]} callbackUrl="" />,
    ),
  ).toContain("由服务器环境变量管理");
});
it("enforces origin, session ownership and exact environment-switch confirmation", async () => {
  expect((await api.GET(await request("GET", null))).status).toBe(401);
  expect((await api.PUT(await request("PUT", ownerId, draft, "https://evil.example"))).status).toBe(403);
  expect((await testApi.POST(await request("POST", ownerId, draft, "https://evil.example"))).status).toBe(
    403,
  );
  expect((await api.PUT(await request("PUT", ownerId, { ...draft, ownerId: otherId }))).status).toBe(400);
  await save();
  await connection(ownerId, "sandbox");
  await connection(otherId, "production");
  expect(await connectionEnvironments(h.db, ownerId)).toEqual([{ environment: "sandbox", count: 1 }]);
  expect(await (await environmentsApi.GET(await request("GET", otherId))).json()).toEqual([
    { environment: "production", count: 1 },
  ]);
  const switchDraft = { ...draft, environment: "production" as const };
  await expect(savePlaidSettings(h.db, ownerId, switchDraft, emptyEnv, true, verify)).rejects.toThrow(
    "停止同步",
  );
  await savePlaidSettings(
    h.db,
    ownerId,
    { ...switchDraft, confirmEnvironmentChange: true },
    emptyEnv,
    true,
    verify,
  );
  expect((await publicPlaidSettings(h.db, otherId, emptyEnv)).hasSecret).toBe(false);
  await save({ ...draft, clientId: "other-client", secret: "other-synthetic-secret" }, otherId);
  expect((await publicPlaidSettings(h.db, ownerId, emptyEnv)).clientId).toBe(draft.clientId);
});
it("schedules each owner's enabled environment and pauses stale jobs without spending retries", async () => {
  await save({ ...draft, enabled: true }, ownerId, true);
  await savePlaidSettings(
    h.db,
    otherId,
    { ...draft, environment: "production", enabled: true },
    emptyEnv,
    true,
    verify,
  );
  const sandbox = await connection(ownerId, "sandbox");
  await connection(ownerId, "production");
  const production = await connection(otherId, "production");
  await connection(otherId, "sandbox");
  const now = new Date("2026-10-26T00:00:00Z");
  await scheduleSyncs(h.db, emptyEnv, now);
  const jobs = await h.db.select().from(importJobs);
  expect(jobs.map((row) => row.connectionId).sort()).toEqual([sandbox.id, production.id].sort());
  const claimed = (await claimJob(h.db, "synthetic-worker", now, true))!;
  await h.db.update(plaidSettings).set({ enabled: false }).where(eq(plaidSettings.ownerId, claimed.ownerId));
  const factory = vi.fn(() => new FakePlaid());
  await processConfiguredBankJob(h.db, claimed, emptyEnv, now, factory);
  expect(factory).not.toHaveBeenCalled();
  const [paused] = await h.db.select().from(importJobs).where(eq(importJobs.id, claimed.id));
  expect(paused).toMatchObject({ status: "queued", attempts: 0, lockedBy: null });
  await h.db.update(plaidSettings).set({ enabled: true }).where(eq(plaidSettings.ownerId, claimed.ownerId));
  const active = (await claimJob(h.db, "synthetic-worker", new Date(now.getTime() + 60000), true))!;
  await processConfiguredBankJob(h.db, active, emptyEnv, now, factory);
  expect(factory).toHaveBeenCalledWith(
    expect.objectContaining({
      PLAID_ENV: active.ownerId === ownerId ? "sandbox" : "production",
      PLAID_SECRET: draft.secret,
    }),
  );
});
it("delete-all removes only the owner's settings and refuses other-environment revocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synthetic-plaid-settings-"));
  try {
    await save();
    await save(draft, otherId);
    await h.db
      .update(users)
      .set({ passwordHash: await hashPassword("synthetic-settings-password") })
      .where(eq(users.id, ownerId));
    const input = { confirmation: DELETE_CONFIRMATION, password: "synthetic-settings-password" };
    const otherEnv = await connection(ownerId, "production");
    const config = { ...(await loadPlaidConfig(h.db, ownerId, emptyEnv)).config, DATA_DIR: dir };
    await expect(deleteOwnerData(h.db, ownerId, input, config)).rejects.toThrow("逐一撤销");
    await h.db.update(bankConnections).set({ status: "revoked" }).where(eq(bankConnections.id, otherEnv.id));
    await deleteOwnerData(h.db, ownerId, input, config);
    expect(await h.db.select({ ownerId: plaidSettings.ownerId }).from(plaidSettings)).toEqual([
      { ownerId: otherId },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
