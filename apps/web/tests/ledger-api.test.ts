import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { createSession } from "@/lib/auth/session";
import { createQuickEntry } from "@/lib/ledger/builders";
import { getEntry } from "@/lib/ledger/entries";
let harness: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
let token: string;
let otherToken: string;
vi.mock("@/db/client", () => ({ getDb: () => harness.db }));
const accountsRoute = await import("@/app/api/accounts/route");
const transactionsRoute = await import("@/app/api/transactions/route");
const detailRoute = await import("@/app/api/transactions/[id]/route");
const voidRoute = await import("@/app/api/transactions/[id]/void/route");
const replaceRoute = await import("@/app/api/transactions/[id]/replace/route");
const accountPatch = await import("@/app/api/accounts/[id]/route");
beforeAll(async () => {
  harness = await createTestDb();
  vi.stubEnv("APP_SECRET", "synthetic-ledger-api-test-secret-32-chars");
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic/test");
});
afterAll(async () => {
  await harness.client.close();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  await harness.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(harness.db);
  token = (await createSession(harness.db, f.ownerId, { ipHash: "synthetic", userAgent: "Test" })).token;
  otherToken = (await createSession(harness.db, f.otherId, { ipHash: "synthetic", userAgent: "Test" })).token;
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
      "content-type": "application/json",
      ...(session ? { cookie: `al_session=${session}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
it("requires auth and origin, rejects client owner IDs and isolates account reads/edits", async () => {
  expect((await accountsRoute.GET(request("/api/accounts", "GET", undefined, null))).status).toBe(401);
  expect(
    (await accountsRoute.POST(request("/api/accounts", "POST", {}, token, "https://evil.example.com")))
      .status,
  ).toBe(403);
  expect(
    (
      await accountsRoute.POST(
        request("/api/accounts", "POST", {
          name: "Injected",
          type: "asset_cash",
          currency: "USD",
          ownerId: f.otherId,
        }),
      )
    ).status,
  ).toBe(400);
  const result = await accountsRoute.GET(request("/api/accounts", "GET", undefined, otherToken));
  expect(await result.json()).toEqual({ accounts: [] });
  expect(
    (
      await accountPatch.PATCH(
        request(`/api/accounts/${f.bank.id}`, "PATCH", { name: "Not allowed" }, otherToken),
        { params: Promise.resolve({ id: f.bank.id }) },
      )
    ).status,
  ).toBe(404);
});
it("second user cannot read, void, replace or list the first user's transaction", async () => {
  const entry = await createQuickEntry(harness.db, f.ownerId, {
    type: "expense",
    amount: "116",
    fromAccountId: f.card.id,
    categoryId: f.category("购物"),
    eventDate: "2026-10-01",
  });
  const context = { params: Promise.resolve({ id: entry.id }) };
  expect(
    (await detailRoute.GET(request(`/api/transactions/${entry.id}`, "GET", undefined, otherToken), context))
      .status,
  ).toBe(404);
  expect(
    (
      await voidRoute.POST(
        request(`/api/transactions/${entry.id}/void`, "POST", { reason: "attempt" }, otherToken),
        context,
      )
    ).status,
  ).toBe(404);
  expect(
    (await transactionsRoute.GET(request("/api/transactions", "GET", undefined, otherToken))).status,
  ).toBe(200);
  expect(
    (await (await transactionsRoute.GET(request("/api/transactions", "GET", undefined, otherToken))).json())
      .total,
  ).toBe(0);
  const replacement = {
    entryType: "expense",
    eventDate: "2026-10-01",
    postings: entry.postings.map(({ accountId, categoryId, amount, currency }) => ({
      accountId,
      categoryId,
      amount,
      currency,
    })),
  };
  expect(
    (
      await replaceRoute.POST(
        request(
          `/api/transactions/${entry.id}/replace`,
          "POST",
          { reason: "attempt", entry: replacement },
          otherToken,
        ),
        context,
      )
    ).status,
  ).toBe(404);
  expect((await getEntry(harness.db, f.ownerId, entry.id)).status).toBe("confirmed");
});
it("creates a balanced quick transaction through HTTP and enforces float rejection", async () => {
  const input = {
    type: "expense",
    amount: "116",
    fromAccountId: f.card.id,
    categoryId: f.category("购物"),
    eventDate: "2026-10-01",
  };
  const response = await transactionsRoute.POST(
    request("/api/transactions", "POST", { mode: "quick", input }),
  );
  expect(response.status).toBe(200);
  const created = await response.json();
  expect(created.postings).toHaveLength(2);
  expect(
    (
      await transactionsRoute.POST(
        request("/api/transactions", "POST", { mode: "quick", input: { ...input, amount: 0.1 } }),
      )
    ).status,
  ).toBe(400);
  const list = await transactionsRoute.GET(
    request("/api/transactions?view=spending&minAmount=100&maxAmount=120"),
  );
  expect((await list.json()).total).toBe(1);
});
