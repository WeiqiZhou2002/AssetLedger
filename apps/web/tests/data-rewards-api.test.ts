import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { users, sessions, statements, loyaltyEvents } from "@/db/schema";
import { createSession } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { makeTotp } from "@/lib/auth/totp";
import { encryptSecret } from "@/lib/auth/crypto";
import { listPrograms, saveLoyaltyAccount, createEvent } from "@/lib/rewards/service";
import { createAccount } from "@/lib/ledger/accounts";
import { uploadStatement } from "@/lib/imports/service";
import { readEnv } from "@/lib/env";
import { exportOwnerData, exportOwnerCsv } from "@/lib/data/export";
import { deleteOwnerData, DELETE_CONFIRMATION } from "@/lib/data/delete";
import { ownerTables } from "@/lib/data/tables";
import { loadDemoLedger } from "../../../fixtures/demo/demo-ledger";
let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
let token: string;
let foreign: string;
let dir: string;
let passwordHash: string;
const password = "Synthetic-Delete-Password-2026";
const appSecret = "synthetic-rewards-delete-secret-32-chars";
vi.mock("@/db/client", () => ({ getDb: () => h.db }));
const events = await import("@/app/api/loyalty/events/route");
const accounts = await import("@/app/api/loyalty/accounts/route");
const accountDetail = await import("@/app/api/loyalty/accounts/[id]/route");
const deletePreview = await import("@/app/api/loyalty/accounts/[id]/delete-preview/route");
const exported = await import("@/app/api/export/route");
const deletion = await import("@/app/api/settings/data/route");
beforeAll(async () => {
  h = await createTestDb();
  passwordHash = await hashPassword(password);
  dir = await mkdtemp(join(tmpdir(), "rewards-data-tests-"));
  vi.stubEnv("APP_SECRET", appSecret);
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic/test");
  vi.stubEnv("DATA_DIR", dir);
});
afterAll(async () => {
  await h.client.close();
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
  await h.db.update(users).set({ passwordHash }).where(eq(users.id, f.ownerId));
  token = (await createSession(h.db, f.ownerId, { ipHash: "synthetic", userAgent: "Test" })).token;
  foreign = (await createSession(h.db, f.otherId, { ipHash: "synthetic", userAgent: "Test" })).token;
});
function request(
  path: string,
  method = "GET",
  body?: unknown,
  session: string | null = token,
  origin = "http://localhost:3000",
) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: {
      host: "localhost:3000",
      origin,
      "Content-Type": "application/json",
      ...(session ? { cookie: `al_session=${session}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function pointsAccount() {
  const programs = await listPrograms(h.db, f.ownerId);
  return saveLoyaltyAccount(h.db, f.ownerId, {
    programId: programs.find((row) => row.code === "AA")!.id,
    name: "Synthetic AA",
  });
}
it("serializes BigInt as full decimal strings through authenticated APIs and enforces origin/owner isolation", async () => {
  const account = await pointsAccount();
  expect((await accounts.GET(request("/api/loyalty/accounts", "GET", undefined, null))).status).toBe(401);
  const body = {
    loyaltyAccountId: account.id,
    eventDate: "2026-10-24",
    pointsDelta: "9007199254740993",
    type: "earn",
  };
  expect(
    (await events.POST(request("/api/loyalty/events", "POST", body, token, "https://evil.example"))).status,
  ).toBe(403);
  expect((await events.POST(request("/api/loyalty/events", "POST", body, foreign))).status).toBe(404);
  const response = await events.POST(request("/api/loyalty/events", "POST", body));
  expect(response.status).toBe(200);
  expect((await response.json()).pointsDelta).toBe("9007199254740993");
  expect((await events.GET(request("/api/loyalty/events"))).status).toBe(200);
  expect(await (await events.GET(request("/api/loyalty/events", "GET", undefined, foreign))).json()).toEqual(
    [],
  );
  expect(
    (await events.POST(request("/api/loyalty/events", "POST", { ...body, pointsDelta: 100 }))).status,
  ).toBe(400);
});
it("exports all owned data as JSON or per-table CSV without authentication secrets", async () => {
  const account = await pointsAccount();
  await createEvent(h.db, f.ownerId, {
    loyaltyAccountId: account.id,
    eventDate: "2026-10-24",
    pointsDelta: "9007199254740993",
    type: "earn",
    note: '=HYPERLINK("synthetic")',
  });
  await h.db
    .update(users)
    .set({
      totpSecretEnc: "synthetic-secret-must-not-export",
      totpPendingSecretEnc: "synthetic-pending-secret",
    })
    .where(eq(users.id, f.ownerId));
  const response = await exported.GET(request("/api/export?format=json"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-disposition")).toContain("attachment");
  const text = await response.text();
  for (const secret of [
    passwordHash,
    "synthetic-secret-must-not-export",
    "synthetic-pending-secret",
    token,
    "passwordHash",
    "totpSecretEnc",
    "sessions",
  ])
    expect(text).not.toContain(secret);
  const data = JSON.parse(text);
  expect(Object.keys(data.tables).sort()).toEqual(["profile", ...Object.keys(ownerTables)].sort());
  expect(data.tables.loyalty_events[0].pointsDelta).toBe("9007199254740993");
  expect(data.tables.profile).toHaveLength(1);
  expect(data.tables.profile[0].id).toBe(f.ownerId);
  expect(text).not.toContain("other@example.com");
  const csv = await exportOwnerCsv(h.db, f.ownerId, "loyalty_events");
  expect(csv).toContain('"9007199254740993"');
  expect(csv).toContain("'=HYPERLINK");
  expect((await exported.GET(request("/api/export?format=csv&table=users"))).status).toBe(400);
  expect((await exported.GET(request("/api/export?format=json", "GET", undefined, null))).status).toBe(401);
  expect(
    (await exported.GET(request("/api/export?format=csv&table=loyalty_events"))).headers.get("content-type"),
  ).toContain("text/csv");
});
it("deletion requires exact phrase/password/TOTP and keeps the account while revoking every session", async () => {
  const account = await pointsAccount();
  await createEvent(h.db, f.ownerId, {
    loyaltyAccountId: account.id,
    eventDate: "2026-10-24",
    pointsDelta: "100",
    type: "earn",
  });
  const body = { confirmation: DELETE_CONFIRMATION, password };
  expect(
    (await deletion.DELETE(request("/api/settings/data", "DELETE", { ...body, confirmation: "delete" })))
      .status,
  ).toBe(400);
  expect(
    (await deletion.DELETE(request("/api/settings/data", "DELETE", { ...body, password: "wrong" }))).status,
  ).toBe(403);
  expect(
    (await deletion.DELETE(request("/api/settings/data", "DELETE", body, token, "https://evil.example")))
      .status,
  ).toBe(403);
  const secret = "JBSWY3DPEHPK3PXP";
  const now = new Date("2026-10-24T12:00:00Z");
  await h.db
    .update(users)
    .set({ totpSecretEnc: encryptSecret(secret, appSecret), totpEnabledAt: now })
    .where(eq(users.id, f.ownerId));
  await expect(deleteOwnerData(h.db, f.ownerId, body, readEnv(), now)).rejects.toThrow("验证码");
  expect(await h.db.select().from(loyaltyEvents)).toHaveLength(1);
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  await deleteOwnerData(
    h.db,
    f.ownerId,
    { ...body, totpCode: makeTotp(secret).generate({ timestamp: now.getTime() }) },
    readEnv(),
    now,
  );
  expect(log).toHaveBeenCalledWith(JSON.stringify({ kind: "owner_data_deleted", ownerId: f.ownerId }));
  log.mockRestore();
  const [user] = await h.db.select().from(users).where(eq(users.id, f.ownerId));
  expect(user.passwordHash).toBe(passwordHash);
  expect(user.totpEnabledAt).not.toBeNull();
  expect(await h.db.select().from(sessions).where(eq(sessions.userId, f.ownerId))).toHaveLength(0);
  expect(await h.db.select().from(sessions).where(eq(sessions.userId, f.otherId))).toHaveLength(1);
  expect((await accounts.GET(request("/api/loyalty/accounts"))).status).toBe(401);
});
it("deletes every owned table and only the owner's unshared files, including page cache", async () => {
  await loadDemoLedger(h.db, f.ownerId);
  const account = await pointsAccount();
  await createEvent(h.db, f.ownerId, {
    loyaltyAccountId: account.id,
    eventDate: "2026-10-24",
    pointsDelta: "100",
    type: "earn",
  });
  const otherCard = await createAccount(h.db, f.otherId, {
    name: "Other Synthetic Card",
    type: "liability_credit_card",
    currency: "USD",
  });
  const config = readEnv();
  const csv = (merchant: string) =>
    new TextEncoder().encode(`Date,Receipt,Description,Amount\n10/24/2026,,${merchant},12.00\n`);
  const own = await uploadStatement(
    h.db,
    f.ownerId,
    { filename: "owner.csv", bytes: csv("OWNER ONLY"), accountId: f.card.id },
    config,
  );
  const shared = await uploadStatement(
    h.db,
    f.ownerId,
    { filename: "shared.csv", bytes: csv("SHARED"), accountId: f.card.id },
    config,
  );
  const other = await uploadStatement(
    h.db,
    f.otherId,
    { filename: "shared.csv", bytes: csv("SHARED"), accountId: otherCard.id },
    config,
  );
  const [ownFile] = await h.db.select().from(statements).where(eq(statements.id, own.id));
  const [sharedFile] = await h.db.select().from(statements).where(eq(statements.id, shared.id));
  const pageDir = join(dir, "statements", own.fileSha256!, "pages");
  await mkdir(pageDir, { recursive: true });
  await writeFile(join(pageDir, "1.png"), "synthetic");
  const otherBefore = await exportOwnerData(h.db, f.otherId);
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const response = await deletion.DELETE(
    request("/api/settings/data", "DELETE", { confirmation: DELETE_CONFIRMATION, password }),
  );
  log.mockRestore();
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  for (const table of Object.values(ownerTables))
    expect(await h.db.select().from(table).where(eq(table.ownerId, f.ownerId))).toHaveLength(0);
  expect((await exportOwnerData(h.db, f.otherId)).tables).toEqual(otherBefore.tables);
  await expect(readFile(ownFile.storagePath!)).rejects.toThrow();
  await expect(readFile(join(pageDir, "1.png"))).rejects.toThrow();
  expect((await readFile(sharedFile.storagePath!)).length).toBeGreaterThan(0);
  expect(await h.db.select().from(statements).where(eq(statements.id, other.id))).toHaveLength(1);
});

it("account deletion preview and DELETE require owner/session/origin and a fresh count confirmation", async () => {
  const account = await pointsAccount();
  const path = `/api/loyalty/accounts/${account.id}`;
  const context = { params: Promise.resolve({ id: account.id }) };
  expect(
    (await deletePreview.GET(request(`${path}/delete-preview`, "GET", undefined, null), context)).status,
  ).toBe(401);
  expect(
    (await deletePreview.GET(request(`${path}/delete-preview`, "GET", undefined, foreign), context)).status,
  ).toBe(404);
  const preview = await deletePreview.GET(request(`${path}/delete-preview`), context);
  expect(preview.status).toBe(200);
  const counts = await preview.json();
  expect((await accountDetail.DELETE(request(path, "DELETE", counts, null), context)).status).toBe(401);
  expect((await accountDetail.DELETE(request(path, "DELETE", counts, foreign), context)).status).toBe(404);
  expect(
    (await accountDetail.DELETE(request(path, "DELETE", counts, token, "https://evil.example"), context))
      .status,
  ).toBe(403);
  expect(
    (await accountDetail.DELETE(request(path, "DELETE", { ...counts, ownerId: f.otherId }), context)).status,
  ).toBe(400);
  expect(
    (await accountDetail.DELETE(request(path, "DELETE", { ...counts, events: 99 }), context)).status,
  ).toBe(409);
  expect((await accountDetail.DELETE(request(path, "DELETE", counts), context)).status).toBe(200);
  expect(await (await accounts.GET(request("/api/loyalty/accounts"))).json()).toEqual([]);
});
