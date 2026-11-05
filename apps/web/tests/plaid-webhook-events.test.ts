import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { FakePlaid, plaidConfig as config, plaidFailure } from "./helpers/plaid";
import { auditLogs, bankConnections, bankSyncRuns } from "@/db/schema";
import {
  dismissNewAccounts,
  exchangeConnection,
  refreshConnection,
  requireConnection,
  saveMapping,
} from "@/lib/bank-sync/connections";
import { pollNewAccountEvents } from "@/lib/bank-sync/webhook-events";
import { syncConnection } from "@/lib/bank-sync/sync";
import type { WebhookEvent, WebhookEventsPage } from "@/lib/bank-sync/types";

let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
let client: FakePlaid;
let id: string;
const now = new Date("2026-11-05T12:00:00Z");
const recent = new Date("2026-11-04T12:00:00Z");
const startTime = "2026-10-29T12:10:00.000Z";
const event = (changes: Partial<WebhookEvent> = {}): WebhookEvent => ({
  itemId: client.item.id,
  type: "ITEM",
  code: "NEW_ACCOUNTS_AVAILABLE",
  sentAt: recent.toISOString(),
  ...changes,
});
const page = (events: WebhookEvent[] = [], changes: Partial<WebhookEventsPage> = {}): WebhookEventsPage => ({
  events,
  hasMore: false,
  nextCursor: "events-next",
  ...changes,
});
const connection = () => requireConnection(h.db, f.ownerId, id);
const sync = () => syncConnection(h.db, f.ownerId, id, client, config, now);
const notices = () =>
  h.db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.ownerId, f.ownerId), eq(auditLogs.action, "bank.new_accounts_available")));
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.client.close();
});
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
  client = new FakePlaid();
  const result = await exchangeConnection(
    h.db,
    f.ownerId,
    client,
    config,
    {
      public_token: "synthetic-public-token",
      institution: { institution_id: "synthetic-institution", name: "Example Bank" },
    },
    recent,
  );
  id = result.connection.id;
  await saveMapping(
    h.db,
    f.ownerId,
    id,
    config,
    { importFromDate: result.connection.importFromDate, accounts: [] },
    recent,
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

it("polls after sync commits and sets one audited reminder across repeated polls", async () => {
  client.eventPage = async () => {
    expect((await connection()).lastSuccessAt).toEqual(now);
    expect((await h.db.select().from(bankSyncRuns))[0].status).toBe("succeeded");
    return page([event()]);
  };
  expect((await sync()).notReady).toBe(false);
  expect((await connection()).newAccountsAvailableAt).toEqual(now);
  await sync();
  expect(client.webhookEventRequests).toEqual(
    [0, 1].map(() => ({
      start_time: startTime,
      count: 100,
      webhook_codes: ["NEW_ACCOUNTS_AVAILABLE"],
      item_ids: [client.item.id],
    })),
  );
  const logs = await notices();
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({ entityId: id, changes: {} });
  expect(JSON.stringify(logs)).not.toContain(client.item.id);
});

it.each([-1, 0, 1])("only flags events strictly newer than handled_at (offset %s ms)", async (offset) => {
  await h.db
    .update(bankConnections)
    .set({ newAccountsAvailableAt: recent })
    .where(eq(bankConnections.id, id));
  await dismissNewAccounts(h.db, f.ownerId, id, recent);
  client.eventPage = () => page([event({ sentAt: new Date(recent.getTime() + offset).toISOString() })]);
  await sync();
  expect((await connection()).newAccountsAvailableAt).toEqual(offset > 0 ? now : null);
  expect((await connection()).newAccountsHandledAt).toEqual(recent);
  expect(client.webhookEventRequests[0].start_time).toBe(recent.toISOString());
  expect(await notices()).toHaveLength(offset > 0 ? 1 : 0);
});

it("clamps an old handled_at to the retained seven-day window plus ten minutes", async () => {
  await h.db
    .update(bankConnections)
    .set({ newAccountsHandledAt: new Date("2026-10-01T12:00:00Z") })
    .where(eq(bankConnections.id, id));
  await sync();
  expect(client.webhookEventRequests[0].start_time).toBe(startTime);
});

it("locally filters Item, ITEM type and code even when the provider returns unrelated events", async () => {
  client.eventPage = () =>
    page([
      event({ itemId: "other-item" }),
      event({ itemId: null }),
      event({ type: "TRANSACTIONS" }),
      event({ code: "WEBHOOK_UPDATE_ACKNOWLEDGED" }),
    ]);
  await sync();
  expect((await connection()).newAccountsAvailableAt).toBeNull();
  expect(await notices()).toHaveLength(0);
});

it("follows pagination cursors and discovers a new account on a later page", async () => {
  client.eventPage = (request) =>
    request.cursor === "second"
      ? page([event()], { hasMore: true, nextCursor: "third" })
      : request.cursor === "third"
        ? page()
        : page([], { hasMore: true, nextCursor: "second" });
  await sync();
  expect(client.webhookEventRequests.map((request) => request.cursor)).toEqual([
    undefined,
    "second",
    "third",
  ]);
  for (const request of client.webhookEventRequests)
    expect(request).toMatchObject({
      start_time: startTime,
      count: 100,
      item_ids: [client.item.id],
      webhook_codes: ["NEW_ACCOUNTS_AVAILABLE"],
    });
  expect((await connection()).newAccountsAvailableAt).toEqual(now);
});

it("caps pagination at ten pages, logs the limit and preserves the reminder already found", async () => {
  client.eventPage = () =>
    page([event()], { hasMore: true, nextCursor: `cursor-${client.webhookEventRequests.length}` });
  expect((await sync()).notReady).toBe(false);
  expect(client.webhookEventRequests).toHaveLength(10);
  expect((await connection()).newAccountsAvailableAt).toEqual(now);
  expect(await notices()).toHaveLength(1);
  expect(console.error).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ kind: "plaid_webhook_events_failed", connectionId: id, code: "PAGE_LIMIT_EXCEEDED" }),
  );
});

it.each([
  { failure: "repeated_cursor", code: "CURSOR_NOT_ADVANCING" },
  { failure: "missing_cursor", code: "CURSOR_NOT_ADVANCING" },
  { failure: "changed_response", code: "INVALID_RESPONSE" },
  { failure: "network_error", code: "PLAID_REQUEST_FAILED" },
])("preserves earlier events if a later page has $failure", async ({ failure, code }) => {
  client.eventPage = (request) => {
    if (!request.cursor) return page([event()], { hasMore: true, nextCursor: "second" });
    if (failure === "changed_response") return { changed: true } as unknown as WebhookEventsPage;
    if (failure === "network_error") throw new Error("synthetic-private-provider-details");
    return page([], { hasMore: true, nextCursor: failure === "missing_cursor" ? "" : "second" });
  };
  expect((await sync()).notReady).toBe(false);
  expect(client.webhookEventRequests).toHaveLength(2);
  expect((await connection()).newAccountsAvailableAt).toEqual(now);
  expect(await notices()).toHaveLength(1);
  expect(console.error).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ kind: "plaid_webhook_events_failed", connectionId: id, code }),
  );
});

it.each([
  { error: plaidFailure("PRODUCT_NOT_ENABLED"), code: "PRODUCT_NOT_ENABLED" },
  { error: new Error("synthetic-secret-provider-message"), code: "PLAID_REQUEST_FAILED" },
  { error: { response: { data: { error_code: "unsafe code\nprivate" } } }, code: "PLAID_REQUEST_FAILED" },
])("keeps successful sync status when polling fails with $code", async ({ error, code }) => {
  client.eventPage = () => {
    throw error;
  };
  expect((await sync()).notReady).toBe(false);
  expect(await connection()).toMatchObject({
    status: "active",
    errorCode: null,
    lastSuccessAt: now,
    newAccountsAvailableAt: null,
  });
  expect((await h.db.select().from(bankSyncRuns))[0].status).toBe("succeeded");
  expect(await notices()).toHaveLength(0);
  expect(console.error).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ kind: "plaid_webhook_events_failed", connectionId: id, code }),
  );
});

it("treats a changed beta response as non-fatal without inventing a reminder", async () => {
  client.eventPage = () => ({
    events: [{ ...event(), sentAt: "not-a-timestamp" }],
    hasMore: false,
    nextCursor: "next",
  });
  await sync();
  expect((await connection()).newAccountsAvailableAt).toBeNull();
  expect(console.error).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ kind: "plaid_webhook_events_failed", connectionId: id, code: "INVALID_RESPONSE" }),
  );
});

it.each(["dismiss", "account_selection"])(
  "does not restore old events after a concurrent %s",
  async (action) => {
    if (action === "dismiss")
      await h.db
        .update(bankConnections)
        .set({ newAccountsAvailableAt: recent })
        .where(eq(bankConnections.id, id));
    client.eventPage = async () => {
      if (action === "dismiss") await dismissNewAccounts(h.db, f.ownerId, id, now);
      else await refreshConnection(h.db, f.ownerId, id, client, config, now, { accountSelection: true });
      return page([event()]);
    };
    await sync();
    expect(await connection()).toMatchObject({ newAccountsAvailableAt: null, newAccountsHandledAt: now });
    expect(await notices()).toHaveLength(0);
  },
);

it("does not flag a connection revoked while polling", async () => {
  client.eventPage = async () => {
    await h.db.update(bankConnections).set({ status: "revoked" }).where(eq(bankConnections.id, id));
    return page([event()]);
  };
  await sync();
  expect((await connection()).newAccountsAvailableAt).toBeNull();
  expect(await notices()).toHaveLength(0);
});

it("skips polling when disabled, in another environment, or revoked", async () => {
  await pollNewAccountEvents(h.db, f.ownerId, id, client, { ...config, PLAID_ENABLED: "false" }, now);
  await pollNewAccountEvents(h.db, f.ownerId, id, client, { ...config, PLAID_ENV: "production" }, now);
  await h.db.update(bankConnections).set({ status: "revoked" }).where(eq(bankConnections.id, id));
  await pollNewAccountEvents(h.db, f.ownerId, id, client, config, now);
  expect(client.webhookEventRequests).toHaveLength(0);
});

it("cannot poll or update another owner's connection", async () => {
  client.eventPage = () => page([event()]);
  await pollNewAccountEvents(h.db, f.otherId, id, client, config, now);
  expect(client.webhookEventRequests).toHaveLength(0);
  expect((await connection()).newAccountsAvailableAt).toBeNull();
});

it("does not poll when sync is not ready or fails", async () => {
  const original = client.page;
  client.page = () => ({
    accounts: [],
    added: [],
    modified: [],
    removed: [],
    nextCursor: "",
    hasMore: false,
    updateStatus: "NOT_READY",
  });
  expect((await sync()).notReady).toBe(true);
  expect(client.webhookEventRequests).toHaveLength(0);
  client.page = original;
  vi.spyOn(client, "accounts").mockRejectedValueOnce(plaidFailure("ITEM_LOGIN_REQUIRED"));
  await expect(sync()).rejects.toEqual(plaidFailure("ITEM_LOGIN_REQUIRED"));
  expect(client.webhookEventRequests).toHaveLength(0);
});
