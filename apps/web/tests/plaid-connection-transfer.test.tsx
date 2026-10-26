import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { FakePlaid, plaidConfig, plaidFailure } from "./helpers/plaid";
import { bankConnections, bankConnectionAccounts, auditLogs, users } from "@/db/schema";
import { encryptSecret, decryptSecret } from "@/lib/auth/crypto";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { makeTotp } from "@/lib/auth/totp";
import { RATE_LIMIT } from "@/lib/auth/rate-limit";
import { exportConnections } from "@/lib/bank-sync/connection-export";
import { importConnections } from "@/lib/bank-sync/connection-import";
import { decryptTransferBundle, encryptTransferBundle } from "@/lib/bank-sync/transfer-bundle";
import { exchangeConnection, storeAccounts, mappingSuggestions } from "@/lib/bank-sync/connections";
import { ConnectionTransfer, TransferForm } from "@/components/bank-sync/connection-transfer";
import { DuplicateChoices } from "@/components/bank-sync/duplicate-choices";
let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
let client: FakePlaid;
let session: string, passwordHash: string;
const password = "synthetic-owner-password";
const passphrase = "synthetic-bundle-passphrase";
const nextConfig = { ...plaidConfig, APP_SECRET: "synthetic-NEW-instance-app-secret-32" };
vi.mock("@/db/client", () => ({ getDb: () => h.db }));
vi.mock("@/lib/bank-sync/plaid-client", async (original) => ({
  ...(await original<typeof import("@/lib/bank-sync/plaid-client")>()),
  PlaidClient: class {
    constructor() {
      return client;
    }
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const exportRoute = await import("@/app/api/plaid/connections/export/route");
const importRoute = await import("@/app/api/plaid/connections/import/route");
const exchangeRoute = await import("@/app/api/plaid/exchange/route");
beforeAll(async () => {
  h = await createTestDb();
  passwordHash = await hashPassword(password);
  vi.stubEnv("APP_SECRET", plaidConfig.APP_SECRET);
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic/test");
  vi.stubEnv("PLAID_ENABLED", "true");
  vi.stubEnv("PLAID_ENV", "sandbox");
  vi.stubEnv("PLAID_CLIENT_ID", "synthetic-client");
  vi.stubEnv("PLAID_SECRET", "synthetic-secret");
});
afterAll(async () => {
  await h.client.close();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await h.db.execute(sql`truncate users, login_attempts cascade`);
  f = await ledgerFixture(h.db);
  await h.db.update(users).set({ passwordHash });
  session = (await createSession(h.db, f.ownerId, { ipHash: "synthetic", userAgent: "Test" })).token;
  client = new FakePlaid();
});
async function connection(overrides: Partial<typeof bankConnections.$inferInsert> = {}) {
  const [row] = await h.db
    .insert(bankConnections)
    .values({
      ownerId: f.ownerId,
      environment: "sandbox",
      plaidItemId: client.item.id,
      institutionId: client.item.institutionId,
      institutionName: "Example Bank",
      products: ["transactions"],
      accessTokenEnc: encryptSecret(client.accessToken, plaidConfig.APP_SECRET, "plaid-access-token"),
      importFromDate: "2026-08-01",
      daysRequested: 90,
      autoPost: false,
      transactionsCursor: "synthetic-cursor",
      mappingConfirmedAt: new Date(),
      ...overrides,
    })
    .returning();
  await storeAccounts(h.db, row.ownerId, row.id, client.accountRows, new Date());
  return row;
}
const exported = (ownerId = f.ownerId, credentials = { password, passphrase }) =>
  exportConnections(h.db, ownerId, plaidConfig, credentials, "synthetic-ip");
const imported = (
  file: string,
  config = nextConfig,
  ownerId = f.otherId,
  credentials = { password, passphrase },
) => importConnections(h.db, ownerId, client, config, file, credentials, "synthetic-ip");
function request(body: unknown, token: string | null = session, origin = "http://localhost:3000") {
  const multipart = body instanceof FormData;
  return new NextRequest("http://localhost:3000/api/plaid/connections/transfer", {
    method: "POST",
    headers: {
      host: "localhost:3000",
      origin,
      ...(!multipart ? { "content-type": "application/json" } : {}),
      ...(token ? { cookie: `al_session=${token}` } : {}),
    },
    body: multipart ? body : JSON.stringify(body),
  });
}
function form(file: string, credentials: Record<string, string> = { password, passphrase }) {
  const data = new FormData();
  data.set("file", new File([file], "synthetic-transfer.json", { type: "application/json" }));
  for (const [key, value] of Object.entries(credentials)) data.set(key, value);
  return data;
}
it("exports only current owner, current environment, non-revoked connections and metadata", async () => {
  const own = await connection();
  await connection({ ownerId: f.otherId, plaidItemId: "foreign-item" });
  await connection({ environment: "production", plaidItemId: "production-item" });
  await connection({ status: "revoked", plaidItemId: "revoked-item" });
  const file = JSON.stringify(await exported());
  const payload = await decryptTransferBundle(file, passphrase);
  expect(payload.connections).toHaveLength(1);
  expect(payload.connections[0]).toMatchObject({
    plaidItemId: own.plaidItemId,
    accessToken: client.accessToken,
    autoPost: false,
  });
  expect(Object.keys(payload.connections[0]).sort()).toEqual(
    [
      "plaidItemId",
      "accessToken",
      "environment",
      "institutionId",
      "institutionName",
      "products",
      "autoPost",
      "importFromDate",
      "daysRequested",
      "accounts",
    ].sort(),
  );
  expect(Object.keys(payload.connections[0].accounts[0]).sort()).toEqual(
    ["plaidAccountId", "name", "officialName", "mask", "type", "subtype", "currency"].sort(),
  );
  expect(JSON.stringify(payload)).not.toContain(own.id);
  expect(JSON.stringify(payload)).not.toContain("synthetic-cursor");
  const [audit] = await h.db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.action, "bank.connections_exported"));
  expect(audit.changes).toEqual({ connectionIds: [own.id], count: 1 });
});
it("honors connection selection without crossing ownership", async () => {
  const own = await connection();
  const other = await connection({ ownerId: f.otherId });
  const bundle = await exportConnections(
    h.db,
    f.ownerId,
    plaidConfig,
    { password, passphrase, connectionIds: [own.id, other.id] },
    "synthetic-ip",
  );
  expect((await decryptTransferBundle(JSON.stringify(bundle), passphrase)).connections).toHaveLength(1);
});
it("requires step-up and a distinct export passphrase", async () => {
  await connection();
  await expect(exported(f.ownerId, { password: "wrong", passphrase })).rejects.toThrow("验证失败");
  await expect(exported(f.ownerId, { password, passphrase: password })).rejects.toThrow(
    "迁移口令不能与登录密码相同",
  );
  expect(
    await h.db.select().from(auditLogs).where(eq(auditLogs.action, "bank.connections_exported")),
  ).toHaveLength(0);
});
it("requires a fresh TOTP for export and import and never falls back to a password", async () => {
  await connection();
  const secret = "JBSWY3DPEHPK3PXP";
  const now = new Date("2026-10-25T12:00:00Z");
  await h.db
    .update(users)
    .set({ totpEnabledAt: now, totpSecretEnc: encryptSecret(secret, plaidConfig.APP_SECRET) })
    .where(eq(users.id, f.ownerId));
  const code = makeTotp(secret).generate({ timestamp: now.getTime() });
  const bundle = await exportConnections(
    h.db,
    f.ownerId,
    plaidConfig,
    { code, passphrase },
    "synthetic-ip",
    now,
  );
  await expect(
    exportConnections(h.db, f.ownerId, plaidConfig, { code, passphrase }, "synthetic-ip", now),
  ).rejects.toThrow("已使用");
  await expect(
    exportConnections(h.db, f.ownerId, plaidConfig, { password, passphrase }, "synthetic-ip", now),
  ).rejects.toThrow("验证失败");
  await expect(
    importConnections(
      h.db,
      f.ownerId,
      client,
      plaidConfig,
      JSON.stringify(bundle),
      { code, passphrase },
      "synthetic-ip",
      now,
    ),
  ).rejects.toThrow("已使用");
  const later = new Date(now.getTime() + 30000);
  const result = await importConnections(
    h.db,
    f.ownerId,
    client,
    plaidConfig,
    JSON.stringify(bundle),
    { code: makeTotp(secret).generate({ timestamp: later.getTime() }), passphrase },
    "synthetic-ip",
    later,
  );
  expect(result.results[0].status).toBe("existing");
});
it("re-encrypts for the destination instance, leaves mappings pending and uses only verified account membership", async () => {
  const source = await connection();
  const file = JSON.stringify(await exported());
  const exchange = vi.spyOn(client, "exchange");
  const remove = vi.spyOn(client, "remove");
  await h.db
    .update(bankConnectionAccounts)
    .set({ accountId: f.bank.id, isEnabled: true })
    .where(
      and(
        eq(bankConnectionAccounts.connectionId, source.id),
        eq(bankConnectionAccounts.plaidAccountId, "bank"),
      ),
    );
  client.accountRows = [client.accountRows[0]];
  const result = await imported(file);
  expect(result.results[0].status).toBe("imported");
  const [saved] = await h.db
    .select()
    .from(bankConnections)
    .where(eq(bankConnections.id, result.results[0].connectionId!));
  expect(saved.ownerId).toBe(f.otherId);
  expect(saved.mappingConfirmedAt).toBeNull();
  expect(saved.transactionsCursor).toBeNull();
  expect(saved).toMatchObject({ importFromDate: source.importFromDate, daysRequested: 90, autoPost: false });
  expect(decryptSecret(saved.accessTokenEnc, nextConfig.APP_SECRET, "plaid-access-token")).toBe(
    client.accessToken,
  );
  expect(() => decryptSecret(saved.accessTokenEnc, plaidConfig.APP_SECRET, "plaid-access-token")).toThrow();
  expect(() => decryptSecret(saved.accessTokenEnc, nextConfig.APP_SECRET, "totp")).toThrow();
  const accounts = await mappingSuggestions(h.db, f.otherId, saved.id);
  expect(accounts).toHaveLength(1);
  expect(accounts[0]).toMatchObject({
    accountId: null,
    securityAccountId: null,
    isEnabled: false,
    lastBalanceCurrent: null,
    suggestions: [],
  });
  expect(exchange).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  const [audit] = await h.db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.action, "bank.connections_imported"));
  expect(audit.changes).toEqual({ connectionIds: [saved.id], count: 1, existingCount: 0, failedCount: 0 });
  expect(JSON.stringify(audit)).not.toContain(client.accessToken);
  expect(JSON.stringify(audit)).not.toContain(client.item.id);
});
it("skips an existing Item before token verification and refuses locally revoked Items", async () => {
  const row = await connection();
  const file = JSON.stringify(await exported());
  const accounts = vi.spyOn(client, "accounts");
  expect((await imported(file, plaidConfig, f.ownerId)).results[0].status).toBe("existing");
  await h.db.update(bankConnections).set({ status: "revoked" }).where(eq(bankConnections.id, row.id));
  expect((await imported(file, plaidConfig, f.ownerId)).results[0]).toMatchObject({
    status: "failed",
    reason: "本实例已撤销此连接",
  });
  expect(accounts).not.toHaveBeenCalled();
});
it.each(["INVALID_ACCESS_TOKEN", "ITEM_LOGIN_REQUIRED", "MISMATCH"])(
  "skips invalid tokens safely: %s",
  async (kind) => {
    await connection();
    const file = JSON.stringify(await exported());
    if (kind === "MISMATCH") client.item.id = "different-item";
    else vi.spyOn(client, "accounts").mockRejectedValue(plaidFailure(kind));
    const result = await imported(file);
    expect(result.results[0]).toMatchObject({
      status: "failed",
      reason: kind === "ITEM_LOGIN_REQUIRED" ? "需要重新授权" : "令牌无效或 Item 已撤销",
    });
    expect(
      await h.db.select().from(bankConnections).where(eq(bankConnections.ownerId, f.otherId)),
    ).toHaveLength(0);
  },
);
it("rejects disabled Plaid and valid bundles from another environment without contacting Plaid", async () => {
  await connection();
  const payload = await decryptTransferBundle(JSON.stringify(await exported()), passphrase);
  const other = await encryptTransferBundle(
    payload.connections.map((row) => ({ ...row, environment: "production" })),
    "production",
    passphrase,
  );
  const accounts = vi.spyOn(client, "accounts");
  await expect(imported(JSON.stringify(other))).rejects.toThrow("所属环境");
  await expect(imported(JSON.stringify(other), { ...nextConfig, PLAID_ENABLED: "false" })).rejects.toThrow(
    "未启用",
  );
  expect(accounts).not.toHaveBeenCalled();
});
it("serves an authenticated no-store attachment and enforces origin", async () => {
  await connection();
  const response = await exportRoute.POST(request({ password, passphrase }));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("content-disposition")).toMatch(
    /^attachment; filename="asset-ledger-plaid-connections-\d{4}-\d{2}-\d{2}\.json"$/,
  );
  expect(await response.text()).not.toContain(client.accessToken);
  expect((await exportRoute.POST(request({ password, passphrase }, null))).status).toBe(401);
  expect(
    (await exportRoute.POST(request({ password, passphrase }, session, "https://other.example"))).status,
  ).toBe(403);
});
it("imports multipart files with no-store and rejects oversized files and bodies before parsing", async () => {
  await connection({ ownerId: f.otherId });
  const file = JSON.stringify(await exported(f.otherId));
  const response = await importRoute.POST(request(form(file)));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()).results[0].status).toBe("imported");
  expect((await importRoute.POST(request(form(file), null))).status).toBe(401);
  expect((await importRoute.POST(request(form(file), session, "https://other.example"))).status).toBe(403);
  expect((await importRoute.POST(request(form("x".repeat(256 * 1024 + 1))))).status).toBe(413);
  expect((await importRoute.POST(request(form("x".repeat(300 * 1024))))).status).toBe(413);
});
it.each(["export", "import"])("applies the shared step-up limiter to %s", async (kind) => {
  await connection();
  const file = JSON.stringify(await exported());
  for (let i = 0; i < RATE_LIMIT; i++) {
    const response =
      kind === "export"
        ? await exportRoute.POST(request({ password: "wrong", passphrase }))
        : await importRoute.POST(request(form(file, { password: "wrong", passphrase })));
    expect(response.status).toBe(400);
  }
  const response =
    kind === "export"
      ? await exportRoute.POST(request({ password, passphrase }))
      : await importRoute.POST(request(form(file)));
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("900");
});
it("counts incorrect bundle passphrases as failed attempts", async () => {
  await connection();
  const file = JSON.stringify(await exported());
  for (let i = 0; i < RATE_LIMIT; i++)
    await expect(
      imported(file, nextConfig, f.otherId, { password, passphrase: "synthetic-wrong-passphrase" }),
    ).rejects.toThrow("口令错误或文件已损坏");
  await expect(imported(file)).rejects.toMatchObject({ status: 429 });
});
const exchangeInput = {
  public_token: "public-synthetic",
  institution: { institution_id: "ins_synthetic", name: "Example Bank" },
};
it("exchanges outside the persistence transaction even when the connection insert fails", async () => {
  await h.db.execute(
    sql`alter table bank_connections add constraint synthetic_reject_connection check (false)`,
  );
  const exchange = vi.spyOn(client, "exchange");
  const transaction = vi.spyOn(h.db, "transaction");
  const accounts = vi.spyOn(client, "accounts");
  try {
    await expect(exchangeConnection(h.db, f.ownerId, client, plaidConfig, exchangeInput)).rejects.toThrow();
    expect(exchange).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledOnce();
    expect(exchange.mock.invocationCallOrder[0]).toBeLessThan(transaction.mock.invocationCallOrder[0]);
    expect(accounts).not.toHaveBeenCalled();
    expect(await h.db.select().from(bankConnections)).toHaveLength(0);
  } finally {
    await h.db.execute(sql`alter table bank_connections drop constraint synthetic_reject_connection`);
  }
});
it("rejects duplicate institutions with 409 before exchange and audits explicit overrides", async () => {
  await connection();
  client.item.id = "second-item";
  const exchange = vi.spyOn(client, "exchange");
  const response = await exchangeRoute.POST(request(exchangeInput));
  expect(response.status).toBe(409);
  expect((await response.json()).error).toBe("这家银行已连接；请重新授权已有连接，或明确选择仍然添加");
  expect(exchange).not.toHaveBeenCalled();
  const result = await exchangeConnection(h.db, f.ownerId, client, plaidConfig, {
    ...exchangeInput,
    allowDuplicate: true,
  });
  expect(exchange).toHaveBeenCalledOnce();
  const [audit] = await h.db.select().from(auditLogs).where(eq(auditLogs.action, "bank.duplicate_override"));
  expect(audit.entityId).toBe(result.connection.id);
  expect(audit.changes).toEqual({});
});
it.each(["revoked", "other-owner", "other-environment", "other-institution"])(
  "does not block %s connections",
  async (kind) => {
    await connection({
      ...(kind === "revoked" ? { status: "revoked" } : {}),
      ...(kind === "other-owner" ? { ownerId: f.otherId } : {}),
      ...(kind === "other-environment" ? { environment: "production" } : {}),
      ...(kind === "other-institution" ? { institutionId: "ins_other" } : {}),
    });
    client.item.id = "second-item";
    const exchange = vi.spyOn(client, "exchange");
    await exchangeConnection(h.db, f.ownerId, client, plaidConfig, exchangeInput);
    expect(exchange).toHaveBeenCalledOnce();
  },
);
it("renders collapsed migration controls, step-up fields and both duplicate choices", () => {
  const disclosure = renderToStaticMarkup(<ConnectionTransfer totpEnabled={false} />);
  expect(disclosure).toContain('aria-expanded="false"');
  expect(disclosure).toContain("迁移银行连接");
  expect(disclosure).not.toContain('name="password"');
  const passwordForm = renderToStaticMarkup(<TransferForm totpEnabled={false} />);
  expect(passwordForm).toContain("导出连接");
  expect(passwordForm).toContain("导入连接");
  expect(passwordForm).toContain("不要在旧实例点「删除连接」");
  expect(passwordForm).toContain('name="password"');
  const totpForm = renderToStaticMarkup(<TransferForm totpEnabled />);
  expect(totpForm).toContain('name="code"');
  expect(totpForm).not.toContain('name="password"');
  const choices = renderToStaticMarkup(
    <DuplicateChoices pending={false} onAdd={() => {}} onReauthorize={() => {}} />,
  );
  expect(choices).toContain("重新授权已有连接");
  expect(choices).toContain("仍然添加新连接（会占用一个新的 Plaid Item）");
});
