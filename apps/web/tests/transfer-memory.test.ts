import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { FakePlaid, bankAccount, bankTransaction, plaidConfig } from "./helpers/plaid";
import type { BankTransaction } from "@/lib/bank-sync/types";
import * as s from "@/db/schema";
import { exchangeConnection, saveMapping } from "@/lib/bank-sync/connections";
import { syncConnection } from "@/lib/bank-sync/sync";
import { executeReset } from "@/lib/bank-sync/reset";
import { resolveEntryMatching } from "@/lib/bank-sync/matching";
import { resolveTransferSuggestion } from "@/lib/bank-sync/transfer-suggestions";
import { resolvePending } from "@/lib/bank-sync/pending";
import { getEntry, createEntry } from "@/lib/ledger/entries";
import { clearingInput, unlinkLeg } from "@/lib/bank-sync/transfer-legs";
import { restoreTransferChoices } from "@/lib/bank-sync/transfer-restore";
import { loadMatchPool } from "@/lib/bank-sync/match-pool";
import {
  rememberTransferPair,
  rememberTransferRejection,
  assignmentReference,
} from "@/lib/bank-sync/transfer-memory";
import { accountBalance } from "@/lib/ledger/queries";
import { exportOwnerData } from "@/lib/data/export";
import { deleteOwnerData, DELETE_CONFIRMATION } from "@/lib/data/delete";
import { hashPassword } from "@/lib/auth/password";
let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
let dir: string;
const now = new Date("2026-10-24T12:00:00Z");
beforeAll(async () => {
  h = await createTestDb();
  dir = await mkdtemp(join(tmpdir(), "transfer-memory-"));
});
afterAll(async () => {
  await h.client.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
});
async function connect(accountId: string) {
  const client = new FakePlaid();
  client.item.id = `item-${accountId}`;
  client.accountRows = [bankAccount(accountId, accountId === f.card.id ? "credit" : "depository")];
  const linked = await exchangeConnection(
    h.db,
    f.ownerId,
    client,
    plaidConfig,
    {
      public_token: "synthetic",
      institution: { institution_id: `ins_${accountId}`, name: "Example Bank" },
    },
    now,
  );
  await saveMapping(
    h.db,
    f.ownerId,
    linked.connection.id,
    plaidConfig,
    {
      importFromDate: "2026-01-01",
      accounts: [{ id: linked.accounts[0].id, accountId }],
    },
    now,
  );
  return { client, id: linked.connection.id, accountId };
}
type Connection = Awaited<ReturnType<typeof connect>>;
const tx = (c: Connection, id: string, amount: string, date = "2026-10-20") =>
  bankTransaction(id, {
    accountId: c.accountId,
    amount,
    date,
    authorizedDate: date,
    name: "Example movement",
    merchantName: null,
    primary: null,
    detailed: null,
  });
async function sync(c: Connection, added: BankTransaction[] = [], modified: BankTransaction[] = []) {
  c.client.page = () => ({
    accounts: c.client.accountRows,
    added,
    modified,
    removed: [],
    hasMore: false,
    nextCursor: `cursor-${c.client.cursors.length}`,
    updateStatus: "HISTORICAL_UPDATE_COMPLETE",
  });
  return syncConnection(h.db, f.ownerId, c.id, c.client, plaidConfig, now);
}
const current = () =>
  h.db
    .select()
    .from(s.journalEntries)
    .where(and(eq(s.journalEntries.ownerId, f.ownerId), eq(s.journalEntries.status, "confirmed")));
async function entryFor(id: string) {
  const [row] = await h.db
    .select()
    .from(s.importRows)
    .where(and(eq(s.importRows.ownerId, f.ownerId), eq(s.importRows.providerTransactionId, id)));
  return getEntry(h.db, f.ownerId, row.journalEntryId!);
}
async function setupPair() {
  const bank = await connect(f.bank.id),
    card = await connect(f.card.id);
  await sync(bank, [tx(bank, "out", "40")]);
  await sync(card, [tx(card, "in", "-40")]);
  await resolveTransferSuggestion(h.db, f.ownerId, {
    action: "confirm",
    entryId: (await entryFor("out")).id,
    counterpartEntryId: (await entryFor("in")).id,
  });
  expect(await h.db.select().from(s.transferPairConfirmations)).toHaveLength(1);
  return { bank, card };
}
async function expectPair() {
  const entries = await current();
  expect(entries).toHaveLength(2);
  expect(entries.every((entry) => entry.transferMatchId && entry.autoPostOwnerEdited)).toBe(true);
  expect(new Set(entries.map((entry) => entry.transferMatchId)).size).toBe(1);
  expect(await accountBalance(h.db, f.ownerId, f.expense.id, "2026-12-31")).toBe("0.0000");
  expect(await accountBalance(h.db, f.ownerId, f.income.id, "2026-12-31")).toBe("0.0000");
}
const reset = (connections: string[]) =>
  executeReset(
    h.db,
    f.ownerId,
    { ...plaidConfig, DATA_DIR: dir, FILE_RETENTION_DAYS: 30 },
    { connections },
    now,
  );
it.each([false, true])(
  "restores confirmed pairs after %s full reset and reimport beyond both windows",
  async (both) => {
    const { bank, card } = await setupPair();
    await reset(both ? [bank.id, card.id] : [bank.id]);
    await sync(bank, [tx(bank, "out", "40", "2026-10-01")]);
    if (both) await sync(card, [tx(card, "in", "-40")]);
    await expectPair();
    const before = await current();
    await sync(bank);
    await sync(card);
    expect(await current()).toEqual(before);
  },
);
it("upstream modification waits for owner review then restores across replacement/fallback lineage", async () => {
  const { bank } = await setupPair();
  const old = await entryFor("out");
  await sync(bank, [], [tx(bank, "out", "40", "2026-10-01")]);
  expect((await entryFor("out")).id).toBe(old.id);
  const [row] = await h.db.select().from(s.importRows).where(eq(s.importRows.providerTransactionId, "out"));
  expect(row.autoPostState).toBe("upstream");
  await resolvePending(h.db, f.ownerId, plaidConfig, { action: "apply_upstream", rowId: row.id });
  expect((await entryFor("out")).id).not.toBe(old.id);
  await expectPair();
  const before = await current();
  await sync(bank);
  expect(await current()).toEqual(before);
});
it("automatic fallback and a version rescan preserve memory; explicit unmatch removes it", async () => {
  const { bank } = await setupPair();
  const out = await entryFor("out");
  await h.db.transaction((db) => unlinkLeg(db, f.ownerId, out.id));
  expect((await current()).every((entry) => !entry.transferMatchId)).toBe(true);
  expect(await h.db.select().from(s.transferPairConfirmations)).toHaveLength(1);
  await h.db
    .update(s.bankConnections)
    .set({ matchingVersion: 0, benefitVersion: 0 })
    .where(eq(s.bankConnections.ownerId, f.ownerId));
  await sync(bank);
  await expectPair();
  await resolveEntryMatching(h.db, f.ownerId, (await entryFor("out")).id, { action: "unmatch" });
  expect(await h.db.select().from(s.transferPairConfirmations)).toHaveLength(0);
  await sync(bank);
  expect((await current()).every((entry) => !entry.transferMatchId)).toBe(true);
});
it("assignment reuses the unconnected manual counterpart after reset and upstream rewrite", async () => {
  const bank = await connect(f.bank.id);
  await sync(bank, [tx(bank, "assigned", "25")]);
  const source = await entryFor("assigned");
  await resolveEntryMatching(h.db, f.ownerId, source.id, { action: "assign", accountId: f.card.id });
  const [memory] = await h.db.select().from(s.transferAccountAssignments);
  const peer = (await current()).find(
    (entry) => entry.externalReference === assignmentReference(memory.legKey),
  )!;
  expect(peer).toBeTruthy();
  await reset([bank.id]);
  expect((await getEntry(h.db, f.ownerId, peer.id)).status).toBe("confirmed");
  await sync(bank, [tx(bank, "assigned", "25", "2026-10-01")]);
  await expectPair();
  await sync(bank, [], [tx(bank, "assigned", "25", "2026-10-02")]);
  const [row] = await h.db
    .select()
    .from(s.importRows)
    .where(eq(s.importRows.providerTransactionId, "assigned"));
  await resolvePending(h.db, f.ownerId, plaidConfig, { action: "apply_upstream", rowId: row.id });
  await expectPair();
  expect(
    (await current()).filter((entry) => entry.externalReference === assignmentReference(memory.legKey)),
  ).toHaveLength(1);
  const before = await current();
  await sync(bank);
  expect(await current()).toEqual(before);
  await resolveEntryMatching(h.db, f.ownerId, (await entryFor("assigned")).id, { action: "unmatch" });
  expect(await h.db.select().from(s.transferAccountAssignments)).toHaveLength(0);
});
it("recreates a missing assigned counterpart and ignores an inactive target", async () => {
  const bank = await connect(f.bank.id);
  await sync(bank, [tx(bank, "assigned", "25")]);
  await resolveEntryMatching(h.db, f.ownerId, (await entryFor("assigned")).id, {
    action: "assign",
    accountId: f.card.id,
  });
  await reset([bank.id]);
  // Synthetic removal models a reset that includes the generated counterpart.
  const remaining = await current();
  await h.db.delete(s.postings).where(eq(s.postings.journalEntryId, remaining[0].id));
  await h.db.delete(s.journalEntries).where(eq(s.journalEntries.id, remaining[0].id));
  await h.db.update(s.accounts).set({ isActive: false }).where(eq(s.accounts.id, f.card.id));
  await sync(bank, [tx(bank, "assigned", "25")]);
  expect(await current()).toHaveLength(1);
  await h.db.update(s.accounts).set({ isActive: true }).where(eq(s.accounts.id, f.card.id));
  await sync(bank);
  await expectPair();
});
it("remembered pairType and unresolved upstream changes cannot be bypassed", async () => {
  const { bank, card } = await setupPair();
  await reset([bank.id, card.id]);
  await sync(bank, [tx(bank, "out", "41")]);
  await sync(card, [tx(card, "in", "-40")]);
  expect((await current()).every((entry) => !entry.transferMatchId)).toBe(true);
  await h.db
    .update(s.importRows)
    .set({ upstreamState: "modified", autoPostState: "upstream" })
    .where(eq(s.importRows.providerTransactionId, "out"));
  expect(await restoreTransferChoices(h.db, f.ownerId, "sandbox")).toBe(0);
});
it("pending and entry-detail matching persist stable lineage keys, and newest rejection/confirmation wins", async () => {
  const a = await createEntry(
    h.db,
    f.ownerId,
    await clearingInput(h.db, f.ownerId, {
      accountId: f.bank.id,
      amount: "-30",
      currency: "USD",
      transactionDate: "2026-10-20",
      postedDate: null,
      merchantNormalized: "",
      descriptionRaw: "Synthetic transfer",
    }),
  );
  const b = await createEntry(
    h.db,
    f.ownerId,
    await clearingInput(h.db, f.ownerId, {
      accountId: f.card.id,
      amount: "30",
      currency: "USD",
      transactionDate: "2026-10-20",
      postedDate: null,
      merchantNormalized: "",
      descriptionRaw: "Synthetic transfer",
    }),
  );
  await resolvePending(h.db, f.ownerId, plaidConfig, {
    action: "match",
    entryId: a.id,
    counterpartEntryId: b.id,
  });
  const [memory] = await h.db.select().from(s.transferPairConfirmations);
  expect([memory.leftKey, memory.rightKey].sort()).toEqual([`entry:${a.id}`, `entry:${b.id}`].sort());
  await resolveEntryMatching(h.db, f.ownerId, a.id, { action: "unmatch" });
  const { pool } = await loadMatchPool(h.db, f.ownerId);
  expect(pool.map((leg) => leg.legKey).sort()).toEqual([memory.leftKey, memory.rightKey]);
  await rememberTransferRejection(h.db, f.ownerId, memory.leftKey, memory.rightKey);
  const first = pool.find((leg) => leg.accountId === f.bank.id)!;
  const second = pool.find((leg) => leg.accountId === f.card.id)!;
  await resolveEntryMatching(h.db, f.ownerId, first.id, { action: "match", counterpartEntryId: second.id });
  expect(await h.db.select().from(s.transferPairRejections)).toHaveLength(0);
  expect(await h.db.select().from(s.transferPairConfirmations)).toHaveLength(1);
  await rememberTransferRejection(h.db, f.ownerId, memory.rightKey, memory.leftKey);
  expect(await h.db.select().from(s.transferPairConfirmations)).toHaveLength(0);
  expect(await h.db.select().from(s.transferPairRejections)).toHaveLength(1);
});
it("isolates owners, enforces the owned account FK, and exports/deletes opaque memory", async () => {
  const { bank } = await setupPair();
  const [memory] = await h.db.select().from(s.transferPairConfirmations);
  await expect(
    h.db
      .insert(s.transferAccountAssignments)
      .values({ ownerId: f.otherId, legKey: "entry:synthetic", accountId: f.card.id }),
  ).rejects.toThrow();
  await expect(
    resolveEntryMatching(h.db, f.otherId, (await entryFor("out")).id, { action: "unmatch" }),
  ).rejects.toThrow("不存在");
  await reset([bank.id]);
  expect(await restoreTransferChoices(h.db, f.otherId, "sandbox")).toBe(0);
  await rememberTransferPair(h.db, f.otherId, memory.leftKey, memory.rightKey);
  const exported = await exportOwnerData(h.db, f.ownerId);
  expect(JSON.stringify(exported)).toContain("transfer_pair_confirmations");
  expect(JSON.stringify(exported)).toContain(memory.leftKey);
  const [assignment] = await h.db
    .insert(s.transferAccountAssignments)
    .values({ ownerId: f.ownerId, legKey: "entry:synthetic", accountId: f.card.id })
    .returning();
  const withAssignment = await exportOwnerData(h.db, f.ownerId);
  expect(withAssignment.tables.transfer_account_assignments).toMatchObject([{ id: assignment.id }]);
  const audits = await h.db.select().from(s.auditLogs).where(eq(s.auditLogs.ownerId, f.ownerId));
  expect(JSON.stringify(audits.map((row) => row.changes))).not.toContain("ptx:");
  const password = "Synthetic-Memory-Delete-2026";
  await h.db
    .update(s.users)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(s.users.id, f.ownerId));
  await deleteOwnerData(
    h.db,
    f.ownerId,
    { confirmation: DELETE_CONFIRMATION, password },
    { ...plaidConfig, DATA_DIR: dir },
    now,
    new FakePlaid(),
  );
  expect(await h.db.select().from(s.transferAccountAssignments)).toEqual([]);
  expect(await h.db.select().from(s.transferPairConfirmations)).toMatchObject([{ ownerId: f.otherId }]);
});

it("does not rewrite or duplicate an assigned counterpart when the accepted upstream amount changes", async () => {
  const bank = await connect(f.bank.id);
  await sync(bank, [tx(bank, "assigned", "25")]);
  await resolveEntryMatching(h.db, f.ownerId, (await entryFor("assigned")).id, {
    action: "assign",
    accountId: f.card.id,
  });
  const [memory] = await h.db.select().from(s.transferAccountAssignments);
  await sync(bank, [], [tx(bank, "assigned", "30")]);
  const [row] = await h.db
    .select()
    .from(s.importRows)
    .where(eq(s.importRows.providerTransactionId, "assigned"));
  await resolvePending(h.db, f.ownerId, plaidConfig, { action: "apply_upstream", rowId: row.id });
  const entries = await current();
  expect(entries).toHaveLength(2);
  expect(entries.every((entry) => !entry.transferMatchId)).toBe(true);
  expect((await entryFor("assigned")).postings.find((line) => line.accountId === f.bank.id)?.amount).toBe(
    "-30.0000",
  );
  const peer = entries.find((entry) => entry.externalReference === assignmentReference(memory.legKey))!;
  expect(
    (await getEntry(h.db, f.ownerId, peer.id)).postings.find((line) => line.accountId === f.card.id)?.amount,
  ).toBe("25.0000");
  await sync(bank);
  expect(await current()).toEqual(entries);
  expect(await h.db.select().from(s.transferAccountAssignments)).toEqual([memory]);
});
