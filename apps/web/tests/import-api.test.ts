import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { createSession } from "@/lib/auth/session";
import { claimJob, processJob } from "@/lib/imports/jobs";
import { readEnv } from "@/lib/env";
let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
let token: string;
let foreign: string;
let dir: string;
vi.mock("@/db/client", () => ({ getDb: () => h.db }));
const upload = await import("@/app/api/statements/route");
const detail = await import("@/app/api/statements/[id]/route");
const rows = await import("@/app/api/statements/[id]/rows/route");
const approval = await import("@/app/api/statements/[id]/approve/route");
const file = await import("@/app/api/statements/[id]/file/route");
const render = await import("@/app/api/statements/[id]/render/route");
beforeAll(async () => {
  h = await createTestDb();
  dir = await mkdtemp(join(tmpdir(), "import-api-"));
  vi.stubEnv("APP_SECRET", "synthetic-import-api-secret-32-characters");
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic/test");
  vi.stubEnv("DATA_DIR", dir);
});
afterAll(async () => {
  await h.client.close();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
  token = (await createSession(h.db, f.ownerId, { ipHash: "synthetic", userAgent: "Test" })).token;
  foreign = (await createSession(h.db, f.otherId, { ipHash: "synthetic", userAgent: "Test" })).token;
});
const context = (id: string) => ({ params: Promise.resolve({ id }) });
function request(
  method = "GET",
  body?: unknown,
  session: string | null = token,
  origin = "http://localhost:3000",
) {
  return new NextRequest("http://localhost:3000/api/statements", {
    method,
    headers: {
      host: "localhost:3000",
      origin,
      ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(session ? { cookie: `al_session=${session}` } : {}),
    },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
}
it("protects file uploads, review edits, approval and private rendering by session/origin/owner", async () => {
  expect((await upload.GET(request("GET", undefined, null))).status).toBe(401);
  expect((await upload.POST(request("POST", undefined, token, "https://evil.example"))).status).toBe(403);
  const body = new FormData();
  body.set(
    "file",
    new Blob(["Date,Receipt,Description,Amount\n10/12/2026,,EXAMPLE CAFE,12.00\n"], {
      type: "application/octet-stream",
    }),
    "not-a-pdf.pdf",
  );
  body.set("accountId", f.card.id);
  const response = await upload.POST(request("POST", body));
  expect(response.status).toBe(200);
  const statement = await response.json();
  expect(statement.mime).toBe("text/csv");
  expect(statement.storagePath).toBeUndefined();
  const ctx = context(statement.id);
  const job = await claimJob(h.db, "api-test");
  await processJob(h.db, job!, readEnv());
  expect((await detail.GET(request("GET", undefined, foreign), ctx)).status).toBe(404);
  expect((await render.GET(request("GET", undefined, foreign), ctx)).status).toBe(404);
  expect((await file.DELETE(request("DELETE", undefined, foreign), ctx)).status).toBe(404);
  const review = await (await detail.GET(request(), ctx)).json();
  const rowId = review.rows[0].id;
  expect((await rows.PATCH(request("PATCH", { rowIds: [rowId], changes: { amount: 12 } }), ctx)).status).toBe(
    400,
  );
  expect(
    (
      await rows.PATCH(
        request("PATCH", {
          rowIds: [rowId],
          changes: { decision: "approve", suggestedCategoryId: f.category("餐饮") },
        }),
        ctx,
      )
    ).status,
  ).toBe(200);
  expect(
    (await approval.POST(request("POST", { rowIds: [rowId], idempotencyKey: "api-test-1" }, foreign), ctx))
      .status,
  ).toBe(404);
  expect(
    (
      await approval.POST(
        request("POST", { rowIds: [rowId], idempotencyKey: "api-test-1" }, token, "https://evil.example"),
        ctx,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await approval.POST(
        request("POST", { rowIds: [rowId], idempotencyKey: "api-test-1", ownerId: f.otherId }),
        ctx,
      )
    ).status,
  ).toBe(400);
  expect(
    (await approval.POST(request("POST", { rowIds: [rowId], idempotencyKey: "api-test-1" }), ctx)).status,
  ).toBe(200);
  expect(await (await upload.GET(request("GET", undefined, foreign))).json()).toEqual([]);
});
