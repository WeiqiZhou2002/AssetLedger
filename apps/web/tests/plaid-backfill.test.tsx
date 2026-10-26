import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import {
  FakePlaid,
  bankAccount,
  bankTransaction,
  plaidConfig as config,
  plaidFailure,
} from "./helpers/plaid";
import {
  bankConnections,
  bankConnectionAccounts,
  bankSyncRuns,
  importRows,
  journalEntries,
  postings,
  users,
  auditLogs,
  balanceSnapshots,
} from "@/db/schema";
import {
  exchangeConnection,
  saveMapping,
  requireConnection,
  listConnections,
} from "@/lib/bank-sync/connections";
import { syncConnection } from "@/lib/bank-sync/sync";
import { planBackfill, executeBackfill, affectedConnections } from "@/lib/bank-sync/backfill";
import { createSnapshot, publishSnapshot } from "@/lib/snapshots/service";
import { buildPostings, createQuickEntry } from "@/lib/ledger/builders";
import { getEntry, createEntry, updateEntryMeta } from "@/lib/ledger/entries";
import { createAccount } from "@/lib/ledger/accounts";
import { accountBalance } from "@/lib/ledger/queries";
import { syncCounts, countKeys } from "@/lib/bank-sync/run-counts";
import { SyncRunSummary } from "@/components/bank-sync/backfill-form";
import { setAutoPost } from "@/lib/bank-sync/pending";
import { claimJob } from "@/lib/imports/jobs";
let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
const now = new Date("2026-10-24T12:00:00Z");
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.client.close();
});
beforeEach(async () => {
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
});
async function link(client = new FakePlaid(), time = now) {
  return exchangeConnection(
    h.db,
    f.ownerId,
    client,
    config,
    { public_token: "synthetic", institution: { institution_id: "ins_example", name: "Example Bank" } },
    time,
  );
}
async function connect(from = "2026-10-24", id = "bank", ledgerId = f.bank.id) {
  const client = new FakePlaid();
  client.item.id = `item-${id}`;
  client.accountRows = [bankAccount(id)];
  const result = await link(client);
  await saveMapping(
    h.db,
    f.ownerId,
    result.connection.id,
    config,
    { importFromDate: from, accounts: [{ id: result.accounts[0].id, accountId: ledgerId }] },
    now,
  );
  return { client, id: result.connection.id, bankId: result.accounts[0].id };
}
async function run(c: Awaited<ReturnType<typeof connect>>, status = "HISTORICAL_UPDATE_COMPLETE") {
  c.client.page = () => ({
    accounts: c.client.accountRows,
    added: [bankTransaction(`tx-${c.id}`, { accountId: c.client.accountRows[0].id, date: "2026-10-10" })],
    modified: [],
    removed: [],
    nextCursor: "done",
    hasMore: false,
    updateStatus: status,
  });
  return syncConnection(h.db, f.ownerId, c.id, c.client, config, now);
}
const request = { from: "2026-10-01" };
const counts = async () =>
  Promise.all([
    h.db.select().from(importRows),
    h.db.select().from(journalEntries),
    h.db.select().from(postings),
  ]).then((rows) => rows.map((row) => row.length));

it.each([
  { variant: null },
  { variant: ["plaid", false] },
  { variant: ["manual", true] },
  { variant: ["manual", false] },
] as const)("creation default ignores snapshots %j", async ({ variant }) => {
  if (variant) {
    const snapshot = await createSnapshot(h.db, f.ownerId, {
      snapshotDate: "2026-10-24",
      label: "Synthetic",
      items: [{ accountId: f.bank.id, balanceNative: "100", currency: "USD" }],
      fx: [],
    });
    await publishSnapshot(h.db, f.ownerId, snapshot.id);
    await h.db
      .update(balanceSnapshots)
      .set({ source: variant[0], isComplete: variant[1] })
      .where(eq(balanceSnapshots.id, snapshot.id));
  }
  const created = await link();
  expect(created.connection.importFromDate).toBe("2026-07-26");
  const [listed] = await listConnections(h.db, f.ownerId);
  expect(listed.completeSnapshotDate).toBe(variant?.[0] === "manual" && variant[1] ? "2026-10-24" : null);
});
it("bank A's same-day automatic observation cannot shorten bank B's window; timezone is owner-local", async () => {
  const a = await connect();
  await run(a);
  const b = new FakePlaid();
  b.item.id = "later-bank";
  expect((await link(b)).connection.importFromDate).toBe("2026-07-26");
  await h.db.update(users).set({ timezone: "America/Los_Angeles" }).where(eq(users.id, f.ownerId));
  b.item.id = "midnight-bank";
  expect((await link(b, new Date("2026-10-24T02:00:00Z"))).connection.importFromDate).toBe("2026-07-25");
});
it("durably records skips, advances initial cursor, replays history exactly once, and reports only whitelisted counts", async () => {
  const c = await connect();
  await run(c);
  expect(await counts()).toEqual([0, 0, 0]);
  expect((await requireConnection(h.db, f.ownerId, c.id)).transactionsCursor).toBe("done");
  const [listed] = await listConnections(h.db, f.ownerId);
  expect(listed.latestRun?.counts).toMatchObject({ fetched_added: 1, imported: 0, before_start_skipped: 1 });
  const html = renderToStaticMarkup(
    <SyncRunSummary run={listed.latestRun!} timezone="America/Los_Angeles" />,
  );
  expect(html).toContain("生效起始日");
  expect(html).toContain("补导历史流水");
  expect((await affectedConnections(h.db, f.ownerId, config))[0].connectionId).toBe(c.id);
  expect(c.client.cursors).toEqual([null]);
  const before = await requireConnection(h.db, f.ownerId, c.id);
  await executeBackfill(h.db, f.ownerId, c.id, config, request, now);
  expect((await requireConnection(h.db, f.ownerId, c.id)).lastSuccessAt).toEqual(before.lastSuccessAt);
  await run(c);
  expect(await counts()).toEqual([1, 1, 2]);
  await executeBackfill(h.db, f.ownerId, c.id, config, request, now);
  await run(c);
  expect(await counts()).toEqual([1, 1, 2]);
  expect(c.client.cursors).toEqual([null, null, null]);
  const runs = await h.db.select().from(bankSyncRuns);
  for (const row of runs) expect(Object.keys(row.counts).sort()).toEqual([...countKeys].sort());
  expect(Object.keys(syncCounts({ ...{ description: "secret", token: "secret" }, imported: 1 }))).toEqual([
    ...countKeys,
  ]);
  const audits = await h.db.select().from(auditLogs).where(eq(auditLogs.action, "bank.sync"));
  for (const row of audits) expect(Object.keys(row.changes ?? {}).sort()).toEqual([...countKeys].sort());
});
it.each(["keep", "recalculate", "exclude"] as const)(
  "opening conflict policy %s preserves data and is explicit",
  async (action) => {
    const c = await connect();
    const opening = await createQuickEntry(h.db, f.ownerId, {
      type: "opening_balance",
      toAccountId: f.bank.id,
      amount: "1000",
      eventDate: "2026-10-23",
    });
    await run(c);
    const plan = await planBackfill(h.db, f.ownerId, c.id, config, request, now);
    expect(plan.accounts[0]).toMatchObject({
      conflict: true,
      action: "keep",
      effectiveFromDate: "2026-10-24",
      entries: { manual: 1 },
    });
    await executeBackfill(
      h.db,
      f.ownerId,
      c.id,
      config,
      { ...request, actions: [{ accountId: f.bank.id, action }] },
      now,
    );
    await run(c, "INITIAL_UPDATE_COMPLETE");
    expect((await getEntry(h.db, f.ownerId, opening.id)).status).toBe("confirmed");
    expect((await requireConnection(h.db, f.ownerId, c.id)).backfillPlan).not.toBeNull();
    await run(c);
    const old = await getEntry(h.db, f.ownerId, opening.id);
    const [mapping] = await h.db
      .select()
      .from(bankConnectionAccounts)
      .where(eq(bankConnectionAccounts.id, c.bankId));
    if (action === "recalculate") {
      expect(old.status).toBe("voided");
      const [replacement] = await h.db
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.replacesEntryId, old.id));
      expect(replacement.eventDate).toBe("2026-09-30");
      expect(await accountBalance(h.db, f.ownerId, f.bank.id, "2026-10-24")).toBe("1000.0000");
      const sizes = await counts();
      await executeBackfill(
        h.db,
        f.ownerId,
        c.id,
        config,
        { ...request, actions: [{ accountId: f.bank.id, action }] },
        now,
      );
      await run(c);
      expect(await counts()).toEqual(sizes);
    } else {
      expect(old.status).toBe("confirmed");
      expect(await counts()).toEqual([0, 1, 2]);
      if (action === "keep") expect(mapping.importFromDate).toBe("2026-10-24");
      else expect(mapping.isEnabled).toBe(false);
    }
  },
);
it("recalculation rejects multiple openings and protects an opening edited after consent", async () => {
  const c = await connect();
  const opening = await createQuickEntry(h.db, f.ownerId, {
    type: "opening_balance",
    toAccountId: f.bank.id,
    amount: "1000",
    eventDate: "2026-10-23",
  });
  const input = { ...request, actions: [{ accountId: f.bank.id, action: "recalculate" }] };
  await executeBackfill(h.db, f.ownerId, c.id, config, input, now);
  await updateEntryMeta(h.db, f.ownerId, opening.id, { notes: "Owner edit" });
  await expect(run(c)).rejects.toThrow("期初余额在补导确认后已被修改");
  expect(await counts()).toEqual([0, 1, 2]);
  await createQuickEntry(h.db, f.ownerId, {
    type: "opening_balance",
    toAccountId: f.bank.id,
    amount: "2",
    eventDate: "2026-10-22",
  });
  await expect(planBackfill(h.db, f.ownerId, c.id, config, input, now)).rejects.toThrow("多笔有效期初");
});
it("stale leased job cannot commit after a backfill generation changes", async () => {
  const c = await connect();
  const job = await claimJob(h.db, "old-worker", now, true);
  expect(job).toBeTruthy();
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  c.client.page = async () => {
    entered();
    await hold;
    return {
      accounts: c.client.accountRows,
      added: [bankTransaction("stale")],
      modified: [],
      removed: [],
      nextCursor: "stale-cursor",
      hasMore: false,
      updateStatus: "HISTORICAL_UPDATE_COMPLETE",
    };
  };
  const stale = syncConnection(h.db, f.ownerId, c.id, c.client, config, now, job!);
  const rejected = expect(stale).rejects.toThrow();
  await ready;
  await executeBackfill(h.db, f.ownerId, c.id, config, request, now);
  release();
  await rejected;
  expect(await counts()).toEqual([0, 0, 0]);
  expect(await requireConnection(h.db, f.ownerId, c.id)).toMatchObject({
    importFromDate: request.from,
    transactionsCursor: null,
    syncGeneration: 1,
  });
});
it("rejects other owners, environments, inactive connections, and illegal dates without Plaid calls", async () => {
  const c = await connect();
  await expect(planBackfill(h.db, f.otherId, c.id, config, request, now)).rejects.toThrow();
  await expect(
    planBackfill(h.db, f.ownerId, c.id, { ...config, PLAID_ENV: "production" }, request, now),
  ).rejects.toThrow();
  for (const from of ["2026-10-25", "2024-01-01", "2026-02-30", "not-a-date"])
    await expect(planBackfill(h.db, f.ownerId, c.id, config, { from }, now)).rejects.toThrow();
  for (const status of ["revoked", "error", "login_required"] as const) {
    await h.db.update(bankConnections).set({ status }).where(eq(bankConnections.id, c.id));
    await expect(executeBackfill(h.db, f.ownerId, c.id, config, request, now)).rejects.toThrow();
  }
  expect(c.client.cursors).toEqual([]);
});
it("NOT_READY never advances, multi-page replay restarts from null after mutation", async () => {
  const c = await connect();
  await executeBackfill(h.db, f.ownerId, c.id, config, request, now);
  c.client.page = () => ({
    accounts: [],
    added: [],
    modified: [],
    removed: [],
    nextCursor: "",
    hasMore: false,
    updateStatus: "NOT_READY",
  });
  await syncConnection(h.db, f.ownerId, c.id, c.client, config, now);
  expect((await requireConnection(h.db, f.ownerId, c.id)).transactionsCursor).toBeNull();
  c.client.cursors = [];
  c.client.page = (cursor, call) => {
    if (call === 2) throw plaidFailure("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION");
    return {
      accounts: c.client.accountRows,
      added: [bankTransaction(cursor ? "second" : "first", { date: "2026-10-10" })],
      modified: [],
      removed: [],
      nextCursor: cursor ? "done" : "page-2",
      hasMore: !cursor,
      updateStatus: "HISTORICAL_UPDATE_COMPLETE",
    };
  };
  await syncConnection(h.db, f.ownerId, c.id, c.client, config, now);
  expect(c.client.cursors).toEqual([null, "page-2", null, "page-2"]);
  expect(await counts()).toEqual([2, 2, 4]);
});

it("owner-wide posting during backfill respects account windows, PDF duplicates, and owner edits", async () => {
  const a = await connect("2026-10-01", "bank-a", f.bank.id);
  await setAutoPost(h.db, f.ownerId, a.id, config, { autoPost: false });
  await run(a);
  await setAutoPost(h.db, f.ownerId, a.id, config, { autoPost: true });
  const second = await createAccount(h.db, f.ownerId, {
    name: "Second Example Bank",
    type: "asset_cash",
    currency: "USD",
  });
  const pdf = await createEntry(h.db, f.ownerId, {
    ...(await buildPostings(h.db, f.ownerId, "expense", {
      fromAccountId: second.id,
      amount: "20",
      categoryId: f.category("餐饮"),
      eventDate: "2026-10-10",
      merchant: "Example Cafe",
    })),
    source: "import",
  });
  const b = await connect("2026-10-24", "bank-b", second.id);
  await executeBackfill(h.db, f.ownerId, b.id, config, request, now);
  await run(b);
  const rows = await h.db.select().from(importRows);
  const aRow = rows.find((row) => row.bankConnectionId === a.id)!;
  const bRow = rows.find((row) => row.bankConnectionId === b.id)!;
  expect(aRow.journalEntryId).toBeTruthy();
  expect(bRow.autoPostState).toBe("duplicate");
  expect(bRow.linkedEntryId).toBe(pdf.id);
  await updateEntryMeta(h.db, f.ownerId, aRow.journalEntryId!, { notes: "Owner preserved category" });
  const before = await counts();
  await executeBackfill(h.db, f.ownerId, a.id, config, request, now);
  await run(a);
  expect(await counts()).toEqual(before);
  expect((await getEntry(h.db, f.ownerId, aRow.journalEntryId!)).notes).toBe("Owner preserved category");
});
it("per-account keep/exclude also fences previously undecided owner-wide rows", async () => {
  const a = await connect("2026-10-01", "bank-a", f.bank.id);
  await setAutoPost(h.db, f.ownerId, a.id, config, { autoPost: false });
  await run(a);
  await createQuickEntry(h.db, f.ownerId, {
    type: "opening_balance",
    toAccountId: f.bank.id,
    amount: "1000",
    eventDate: "2026-10-23",
  });
  await setAutoPost(h.db, f.ownerId, a.id, config, { autoPost: true });
  await executeBackfill(h.db, f.ownerId, a.id, config, request, now);
  const second = await createAccount(h.db, f.ownerId, {
    name: "Second Example Bank",
    type: "asset_cash",
    currency: "USD",
  });
  const b = await connect("2026-10-24", "bank-b", second.id);
  await run(b);
  expect((await h.db.select().from(importRows))[0].journalEntryId).toBeNull();
  expect(await accountBalance(h.db, f.ownerId, f.bank.id, "2026-10-24")).toBe("1000.0000");
});
it("zero recalculated opening is voided without a zero posting", async () => {
  const c = await connect();
  c.client.accountRows[0].current = "-20.0000";
  const opening = await createQuickEntry(h.db, f.ownerId, {
    type: "opening_balance",
    toAccountId: f.bank.id,
    amount: "1000",
    eventDate: "2026-10-23",
  });
  await executeBackfill(
    h.db,
    f.ownerId,
    c.id,
    config,
    { ...request, actions: [{ accountId: f.bank.id, action: "recalculate" }] },
    now,
  );
  await run(c);
  expect((await getEntry(h.db, f.ownerId, opening.id)).status).toBe("voided");
  expect(await accountBalance(h.db, f.ownerId, f.bank.id, "2026-10-24")).toBe("-20.0000");
  expect((await h.db.select().from(postings)).every((row) => row.amount !== "0.0000")).toBe(true);
});

it("replaying a paired payment preserves both dated legs and their transfer link", async () => {
  const a = await connect();
  const client = new FakePlaid();
  client.item.id = "card-item";
  client.accountRows = [bankAccount("card", "credit")];
  const linked = await link(client);
  await saveMapping(
    h.db,
    f.ownerId,
    linked.connection.id,
    config,
    { importFromDate: "2026-10-24", accounts: [{ id: linked.accounts[0].id, accountId: f.card.id }] },
    now,
  );
  const b = { id: linked.connection.id, bankId: linked.accounts[0].id, client };
  for (const [connection, amount] of [
    [a, "80"],
    [b, "-80"],
  ] as const) {
    connection.client.page = () => ({
      accounts: connection.client.accountRows,
      added: [
        bankTransaction(`payment-${connection.id}`, {
          accountId: connection.client.accountRows[0].id,
          name: "Online Payment",
          amount,
          date: "2026-10-10",
          primary: "LOAN_PAYMENTS",
        }),
      ],
      modified: [],
      removed: [],
      hasMore: false,
      nextCursor: "done",
      updateStatus: "HISTORICAL_UPDATE_COMPLETE",
    });
    await executeBackfill(h.db, f.ownerId, connection.id, config, request, now);
    await syncConnection(h.db, f.ownerId, connection.id, connection.client, config, now);
  }
  const before = await counts();
  const linkedEntries = await h.db
    .select({ id: journalEntries.id, match: journalEntries.transferMatchId })
    .from(journalEntries)
    .where(and(eq(journalEntries.ownerId, f.ownerId), eq(journalEntries.status, "confirmed")));
  expect(linkedEntries).toHaveLength(2);
  expect(linkedEntries[0].match).toBeTruthy();
  expect(linkedEntries[0].match).toBe(linkedEntries[1].match);
  for (const connection of [a, b]) {
    await executeBackfill(h.db, f.ownerId, connection.id, config, request, now);
    await syncConnection(h.db, f.ownerId, connection.id, connection.client, config, now);
  }
  expect(await counts()).toEqual(before);
  expect(
    await h.db
      .select({ id: journalEntries.id, match: journalEntries.transferMatchId })
      .from(journalEntries)
      .where(and(eq(journalEntries.ownerId, f.ownerId), eq(journalEntries.status, "confirmed"))),
  ).toEqual(linkedEntries);
});

it("refuses recalculation if a second opening was added after consent", async () => {
  const c = await connect();
  const old = await createQuickEntry(h.db, f.ownerId, {
    type: "opening_balance",
    toAccountId: f.bank.id,
    amount: "1000",
    eventDate: "2026-10-23",
  });
  await executeBackfill(
    h.db,
    f.ownerId,
    c.id,
    config,
    { ...request, actions: [{ accountId: f.bank.id, action: "recalculate" }] },
    now,
  );
  await createQuickEntry(h.db, f.ownerId, {
    type: "opening_balance",
    toAccountId: f.bank.id,
    amount: "50",
    eventDate: "2026-10-23",
    status: "draft",
  });
  await expect(run(c)).rejects.toThrow("期初集合在补导确认后已改变");
  expect((await getEntry(h.db, f.ownerId, old.id)).status).toBe("confirmed");
  expect(await counts()).toEqual([0, 2, 4]);
});

it("defers ledger-based opening recalculation while historical review rows are undecided, then resumes", async () => {
  const c = await connect();
  await setAutoPost(h.db, f.ownerId, c.id, config, { autoPost: false });
  const opening = await createQuickEntry(h.db, f.ownerId, {
    type: "opening_balance",
    toAccountId: f.bank.id,
    amount: "1000",
    eventDate: "2026-10-23",
  });
  await run(c);
  await executeBackfill(
    h.db,
    f.ownerId,
    c.id,
    config,
    { ...request, actions: [{ accountId: f.bank.id, action: "recalculate" }] },
    now,
  );
  await run(c);
  const rows = await h.db.select().from(importRows).where(eq(importRows.bankConnectionId, c.id));
  expect(rows).toHaveLength(1);
  expect((await requireConnection(h.db, f.ownerId, c.id)).transactionsCursor).toBe("done");
  expect((await requireConnection(h.db, f.ownerId, c.id)).backfillPlan).not.toBeNull();
  expect((await getEntry(h.db, f.ownerId, opening.id)).status).toBe("confirmed");
  const { updateImportRows } = await import("@/lib/imports/review");
  const { approveRows } = await import("@/lib/imports/approval");
  await updateImportRows(h.db, f.ownerId, rows[0].statementId, {
    rowIds: [rows[0].id],
    changes: { decision: "approve" },
  });
  await approveRows(h.db, f.ownerId, rows[0].statementId, {
    rowIds: [rows[0].id],
    idempotencyKey: "synthetic-backfill-review",
  });
  await run(c);
  expect((await getEntry(h.db, f.ownerId, opening.id)).status).toBe("voided");
  expect((await requireConnection(h.db, f.ownerId, c.id)).backfillPlan).toBeNull();
  expect(await accountBalance(h.db, f.ownerId, f.bank.id, "2026-10-24")).toBe("1000.0000");
});
