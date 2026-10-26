import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { accountCardSecrets, accounts, auditLogs, loginAttempts, users } from "@/db/schema";
import { accountSchema } from "@/lib/ledger/schemas";
import { cardNetwork, cardSchema } from "@/lib/ledger/card-schema";
import { cardMeta, saveCard, deleteCard, revealCard } from "@/lib/ledger/card-secrets";
import { createAccount, listAccounts, updateAccount } from "@/lib/ledger/accounts";
import { createSession } from "@/lib/auth/session";
import { decryptSecret, encryptSecret } from "@/lib/auth/crypto";
import { hashPassword } from "@/lib/auth/password";
import { makeTotp } from "@/lib/auth/totp";
import { RATE_LIMIT } from "@/lib/auth/rate-limit";
import { exportOwnerCsv, exportOwnerData } from "@/lib/data/export";
import { exportTableNames } from "@/lib/data/tables";
import { DELETE_CONFIRMATION, deleteOwnerData } from "@/lib/data/delete";

let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
let token: string, foreign: string, passwordHash: string, directory: string;
const secret = "synthetic-card-vault-app-secret-32-characters";
const password = "synthetic-card-vault-password";
const totpSecret = "JBSWY3DPEHPK3PXP";
const visa = { number: "4111111111111111", expMonth: "1", expYear: "29", cvv: "764" };
const amex = { number: "378282246310005", expMonth: "12", expYear: "2030", cvv: "846", cid: "7359" };
const context = { appSecret: secret, ip: "untrusted-client" };
vi.mock("@/db/client", () => ({ getDb: () => h.db }));
vi.mock("@/lib/auth/current-user", () => ({
  requireUser: async () => ({ id: f.ownerId, timezone: "UTC", baseCurrency: "USD", totpEnabledAt: null }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const cardRoute = await import("@/app/api/accounts/[id]/card/route");
const revealRoute = await import("@/app/api/accounts/[id]/card/reveal/route");
const accountRoute = await import("@/app/api/accounts/route");
const { default: AccountsPage } = await import("@/app/(app)/accounts/page");
beforeAll(async () => {
  h = await createTestDb();
  passwordHash = await hashPassword(password);
  directory = await mkdtemp(join(tmpdir(), "synthetic-card-vault-"));
  vi.stubEnv("APP_SECRET", secret);
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic/test");
  vi.stubEnv("PLAID_ENABLED", "false");
});
afterAll(async () => {
  await h.client.close();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  await h.db.execute(sql`truncate users, login_attempts cascade`);
  f = await ledgerFixture(h.db);
  await h.db.update(users).set({ passwordHash }).where(eq(users.id, f.ownerId));
  token = (await createSession(h.db, f.ownerId, { ipHash: "synthetic", userAgent: "Test" })).token;
  foreign = (await createSession(h.db, f.otherId, { ipHash: "synthetic", userAgent: "Test" })).token;
});
function req(
  method: string,
  body?: unknown,
  session: string | null = token,
  origin = "http://localhost:3000",
) {
  return new NextRequest(`http://localhost:3000/api/accounts/${f.card.id}/card`, {
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
const routeContext = (id = f.card.id) => ({ params: Promise.resolve({ id }) });
const saved = () => saveCard(h.db, f.ownerId, f.card.id, visa, secret);
async function enableSyntheticTotp() {
  await h.db
    .update(users)
    .set({
      totpEnabledAt: new Date(),
      totpSecretEnc: encryptSecret(totpSecret, secret),
      totpLastUsedStep: null,
    })
    .where(eq(users.id, f.ownerId));
  return makeTotp(totpSecret).generate();
}

it.each([
  { number: "4111111111111112" },
  { number: "41111111111" },
  { number: "41111111111111111111" },
  { number: "000000000000" },
  { number: "4111x11111111111" },
  { number: 4111111111111111 },
  { expMonth: "0" },
  { expMonth: "13" },
  { expMonth: 1 },
  { expYear: "202" },
  { expYear: 2029 },
  { cvv: "12" },
  { cvv: "12345" },
  { cvv: 123 },
  { cid: "1234" },
  { ownerId: "injected" },
])("rejects invalid card input %#", (change) => {
  expect(cardSchema.safeParse({ ...visa, ...change }).success).toBe(false);
});
it("normalizes numbers and expiry, validates Amex's two codes independently, and derives networks", () => {
  expect(cardSchema.parse({ ...visa, number: "4111-1111 1111 1111" })).toEqual({
    ...visa,
    expMonth: "01",
    expYear: "2029",
  });
  expect(cardSchema.parse(amex)).toEqual(amex);
  expect(cardSchema.safeParse({ ...amex, cvv: "1234" }).success).toBe(false);
  expect(cardSchema.safeParse({ ...amex, cid: "123" }).success).toBe(false);
  expect(cardSchema.safeParse({ ...amex, cvv: undefined, cid: undefined }).success).toBe(true);
  expect(cardSchema.safeParse({ ...visa, cvv: "1234" }).success).toBe(true);
  for (const [number, network] of [
    [visa.number, "visa"],
    [amex.number, "amex"],
    ["5555555555554444", "mastercard"],
    ["2223003122003222", "mastercard"],
    ["6011111111111117", "discover"],
    ["3530111333300000", "other"],
  ]) {
    expect(cardSchema.safeParse({ ...visa, number }).success).toBe(true);
    expect(cardNetwork(number)).toBe(network);
  }
});
it("upserts randomized purpose-isolated ciphertext and exposes only metadata through save, lists and the page", async () => {
  const response = await cardRoute.PUT(req("PUT", visa), routeContext());
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const metadata = await response.json();
  expect(metadata).toEqual({
    accountId: f.card.id,
    numberLast4: "1111",
    network: "visa",
    hasExpiry: true,
    hasCvv: true,
    hasCid: false,
  });
  const [first] = await h.db.select().from(accountCardSecrets);
  expect(first.payloadEnc).not.toContain(visa.number);
  expect(JSON.parse(decryptSecret(first.payloadEnc, secret, "account-card"))).toEqual({
    ...visa,
    expMonth: "01",
    expYear: "2029",
  });
  expect(() => decryptSecret(first.payloadEnc, secret, "plaid-access-token")).toThrow();
  expect(() => decryptSecret(first.payloadEnc, secret)).toThrow();
  await saved();
  const rows = await h.db.select().from(accountCardSecrets);
  expect(rows).toHaveLength(1);
  expect(rows[0].payloadEnc).not.toBe(first.payloadEnc);
  const listed = await (await accountRoute.GET(req("GET"))).json();
  const page = await AccountsPage();
  const pageProps = JSON.stringify(page);
  const html = renderToStaticMarkup(page);
  for (const output of [
    JSON.stringify(await cardMeta(h.db, f.ownerId)),
    JSON.stringify(await listAccounts(h.db, f.ownerId)),
    JSON.stringify(listed),
    pageProps,
    html,
  ]) {
    expect(output).not.toContain(visa.number);
    expect(output).not.toContain('"cvv"');
    expect(output).not.toContain("payloadEnc");
    expect(output).not.toContain(rows[0].payloadEnc);
  }
  expect(pageProps).toContain('"numberLast4":"1111"');
  expect(html).not.toContain("Visa •••• 1111");
  expect(html).not.toContain("CVV 已保存");
  expect(html).not.toContain("卡片信息");
  expect(html).not.toContain("期初");
  await saveCard(h.db, f.ownerId, f.card.id, amex, secret);
  expect((await cardMeta(h.db, f.ownerId))[0]).toMatchObject({ network: "amex", hasCid: true });
});
it("allows cash and credit cards only, and protects saved cards when changing account type", async () => {
  await saveCard(h.db, f.ownerId, f.bank.id, visa, secret);
  for (const account of [f.broker, f.security, f.prepaid, f.expense]) {
    await expect(saveCard(h.db, f.ownerId, account.id, visa, secret)).rejects.toThrow("仅信用卡或现金账户");
  }
  await expect(
    updateAccount(h.db, f.ownerId, f.bank.id, { type: "asset_security", cashLikeInclusion: false }),
  ).rejects.toThrow("请先删除卡片信息");
  await updateAccount(h.db, f.ownerId, f.bank.id, { type: "liability_credit_card" });
  await deleteCard(h.db, f.ownerId, f.bank.id);
  await updateAccount(h.db, f.ownerId, f.bank.id, { type: "asset_security", cashLikeInclusion: false });
});
it("reveals with a fresh TOTP, rejects wrong/reused codes and password bypass, without logging secrets", async () => {
  await saveCard(h.db, f.ownerId, f.card.id, amex, secret);
  const code = await enableSyntheticTotp();
  const wrong = String((Number(code) + 123) % 1000000).padStart(6, "0");
  const logs = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const body of [{ code: wrong }, { password }]) {
      const response = await revealRoute.POST(req("POST", body), routeContext());
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "验证失败，密码或验证码无效或已使用，请重试" });
    }
    const ok = await revealRoute.POST(req("POST", { code }), routeContext());
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Cache-Control")).toBe("no-store");
    expect(await ok.json()).toEqual(amex);
    const replay = await revealRoute.POST(req("POST", { code }), routeContext());
    expect(replay.status).toBe(400);
    expect(replay.headers.get("Cache-Control")).toBe("no-store");
    expect(logs).not.toHaveBeenCalled();
  } finally {
    logs.mockRestore();
  }
  const audit = await h.db
    .select()
    .from(auditLogs)
    .where(sql`${auditLogs.action} like 'account_card.%'`);
  expect(audit.map((row) => row.action)).toEqual(["account_card.saved", "account_card.revealed"]);
  expect(audit.every((row) => row.entityId === f.card.id && JSON.stringify(row.changes) === "{}")).toBe(true);
});
it.each([false, true])("rate-limits failed reveal attempts with TOTP enabled = %s", async (totp) => {
  await saved();
  const code = totp ? await enableSyntheticTotp() : null;
  const wrong = code ? String((Number(code) + 123) % 1000000).padStart(6, "0") : "";
  for (let attempt = 0; attempt < RATE_LIMIT; attempt++) {
    const response = await revealRoute.POST(
      req("POST", totp ? { code: wrong } : { password: "wrong" }),
      routeContext(),
    );
    expect(response.status).toBe(400);
  }
  const blocked = await revealRoute.POST(req("POST", totp ? { code } : { password }), routeContext());
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get("Cache-Control")).toBe("no-store");
  expect(blocked.headers.get("Retry-After")).toBe("900");
  expect(await h.db.select().from(loginAttempts).where(eq(loginAttempts.succeeded, false))).toHaveLength(
    RATE_LIMIT * 2,
  );
});
it("uses the password path when TOTP is disabled and returns metadata only after save/delete", async () => {
  await saved();
  const response = await revealRoute.POST(req("POST", { password }), routeContext());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ...visa, expMonth: "01", expYear: "2029" });
  const deleted = await cardRoute.DELETE(req("DELETE"), routeContext());
  expect(deleted.status).toBe(200);
  expect(deleted.headers.get("Cache-Control")).toBe("no-store");
  expect(await cardMeta(h.db, f.ownerId)).toEqual([]);
  const [audit] = await h.db.select().from(auditLogs).where(eq(auditLogs.action, "account_card.deleted"));
  expect(audit.entityId).toBe(f.card.id);
  expect(audit.changes).toEqual({});
});
it("isolates ownership and rejects untrusted origins, unauthenticated and invalid requests with no-store", async () => {
  await saved();
  for (const [route, method, body] of [
    [cardRoute.PUT, "PUT", visa],
    [cardRoute.DELETE, "DELETE", undefined],
    [revealRoute.POST, "POST", { password }],
  ] as const) {
    for (const [session, origin, status] of [
      [foreign, "http://localhost:3000", 404],
      [null, "http://localhost:3000", 401],
      [token, "https://evil.example.com", 403],
    ] as const) {
      const response = await route(req(method, body, session, origin), routeContext());
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  }
  expect(await cardMeta(h.db, f.otherId)).toEqual([]);
  for (const body of [
    { ...visa, number: "4111111111111112" },
    { ...visa, [visa.number]: "unknown" },
    null,
    [],
  ]) {
    const response = await cardRoute.PUT(req("PUT", body), routeContext());
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).not.toContain(visa.number);
  }
  expect(await h.db.select().from(accountCardSecrets)).toHaveLength(1);
});
it("excludes the vault entirely from personal exports and deletes only the owner's card children", async () => {
  await saved();
  const other = await createAccount(h.db, f.otherId, {
    name: "Demo Other Card",
    type: "liability_credit_card",
    currency: "USD",
  });
  await saveCard(h.db, f.otherId, other.id, amex, secret);
  const [stored] = await h.db
    .select()
    .from(accountCardSecrets)
    .where(eq(accountCardSecrets.ownerId, f.ownerId));
  const exported = JSON.stringify(await exportOwnerData(h.db, f.ownerId));
  expect(exported).not.toContain("account_card_secrets");
  expect(exported).not.toContain(stored.payloadEnc);
  expect(exported).not.toContain(visa.number);
  expect(exportTableNames).not.toContain("account_card_secrets");
  await expect(exportOwnerCsv(h.db, f.ownerId, "account_card_secrets")).rejects.toThrow(
    "请选择可导出的数据表",
  );
  await deleteOwnerData(
    h.db,
    f.ownerId,
    { confirmation: DELETE_CONFIRMATION, password },
    { APP_SECRET: secret, DATA_DIR: directory },
  );
  expect(
    await h.db.select().from(accountCardSecrets).where(eq(accountCardSecrets.ownerId, f.ownerId)),
  ).toEqual([]);
  expect(
    await h.db.select().from(accountCardSecrets).where(eq(accountCardSecrets.ownerId, f.otherId)),
  ).toHaveLength(1);
  // FK also protects future account deletion paths.
  await h.db.delete(accounts).where(and(eq(accounts.ownerId, f.otherId), eq(accounts.id, other.id)));
  expect(await h.db.select().from(accountCardSecrets)).toEqual([]);
});
it("consumes a TOTP step only once through the service's persistent limiter", async () => {
  await saved();
  await enableSyntheticTotp();
  const now = new Date("2026-10-25T12:00:00Z");
  const code = makeTotp(totpSecret).generate({ timestamp: now.getTime() });
  expect((await revealCard(h.db, f.ownerId, f.card.id, { code }, context, () => now)).number).toBe(
    visa.number,
  );
  await expect(revealCard(h.db, f.ownerId, f.card.id, { code }, context, () => now)).rejects.toThrow(
    "验证失败",
  );
});

it.each(["1234", "12345", "00005"])(
  "accepts a four/five-digit account suffix %s in validation and storage",
  async (last4) => {
    expect(
      accountSchema.safeParse({ name: "Demo Card", type: "liability_credit_card", currency: "USD", last4 })
        .success,
    ).toBe(true);
    expect((await updateAccount(h.db, f.ownerId, f.card.id, { last4 })).last4).toBe(last4);
  },
);
it.each(["123", "123456", "12a45", "１２３４５"])("rejects invalid account suffix %s", async (last4) => {
  expect(
    accountSchema.safeParse({ name: "Demo Card", type: "liability_credit_card", currency: "USD", last4 })
      .success,
  ).toBe(false);
  await expect(h.db.update(accounts).set({ last4 }).where(eq(accounts.id, f.card.id))).rejects.toThrow();
});
it.each([null, "0005", "54321", "9999", "10005"])(
  "promotes Amex suffix only when empty or matching last four: %s",
  async (last4) => {
    await updateAccount(h.db, f.ownerId, f.card.id, { last4 });
    await saveCard(h.db, f.ownerId, f.card.id, amex, secret);
    const [account] = await h.db.select().from(accounts).where(eq(accounts.id, f.card.id));
    expect(account.last4).toBe(last4 === null || last4 === "0005" ? "10005" : last4);
    const audits = await h.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "account.card_suffix_updated"));
    expect(audits).toHaveLength(last4 === null || last4 === "0005" ? 1 : 0);
    expect(audits.every((row) => row.entityId === f.card.id && JSON.stringify(row.changes) === "{}")).toBe(
      true,
    );
  },
);
