import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { FakePlaid, bankAccount, bankTransaction, plaidConfig } from "./helpers/plaid";
import * as s from "@/db/schema";
import {
  exchangeConnection,
  saveMapping,
  requireConnection,
  listConnections,
} from "@/lib/bank-sync/connections";
import { syncConnection } from "@/lib/bank-sync/sync";
import { planReset, executeReset } from "@/lib/bank-sync/reset";
import { resetCountKeys } from "@/lib/bank-sync/reset-types";
import {
  listResetExports,
  readResetRecovery,
  resetFile,
  retainResetExports,
} from "@/lib/bank-sync/reset-files";
import { runResetCli } from "@/lib/bank-sync/reset-cli";
import { resolveEntryMatching } from "@/lib/bank-sync/matching";
import { pendingWorkbench, setAutoPost } from "@/lib/bank-sync/pending";
import { createEntry, getEntry, replaceEntry, updateEntryMeta } from "@/lib/ledger/entries";
import { buildPostings, createQuickEntry } from "@/lib/ledger/builders";
import { accountBalance } from "@/lib/ledger/queries";
import { confirmObservedOpening } from "@/lib/ledger/opening-observation";
import { createSnapshot, publishSnapshot } from "@/lib/snapshots/service";
import { createPurchaseGroup, linkGroupEntry } from "@/lib/ledger/purchase-groups";
import { ensurePrograms, saveLoyaltyAccount, createEvent } from "@/lib/rewards/service";
import { rememberedCategory } from "@/lib/imports/category-memory";
import { approveRows } from "@/lib/imports/approval";
import { updateImportRows } from "@/lib/imports/review";
import { claimJob } from "@/lib/imports/jobs";
import { createSession } from "@/lib/auth/session";
import { ResetForm, ResetPreview } from "@/components/bank-sync/reset-form";
import { ConnectionsView } from "@/components/bank-sync/connections-view";
import { jsonSafe } from "@/lib/serialization";
import type { BankTransaction } from "@/lib/bank-sync/types";

let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
let dir: string;
let config: typeof plaidConfig & { DATA_DIR: string; FILE_RETENTION_DAYS: number };
const now = new Date("2026-10-24T12:00:00Z");
vi.mock("@/db/client", () => ({ getDb: () => h.db }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const resetRoute = await import("@/app/api/plaid/reset/route");
const recoveryRoute = await import("@/app/api/plaid/resets/[id]/recovery/route");
beforeAll(async () => {
  h = await createTestDb();
});
beforeEach(async () => {
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = await mkdtemp(join(tmpdir(), "asset-ledger-reset-"));
  config = { ...plaidConfig, DATA_DIR: dir, FILE_RETENTION_DAYS: 30 };
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("APP_SECRET", config.APP_SECRET);
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic/test");
  vi.stubEnv("PLAID_ENABLED", "true");
  vi.stubEnv("PLAID_ENV", "sandbox");
  vi.stubEnv("PLAID_CLIENT_ID", config.PLAID_CLIENT_ID);
  vi.stubEnv("PLAID_SECRET", config.PLAID_SECRET);
  vi.stubEnv("DATA_DIR", dir);
});
afterAll(async () => {
  await h.client.close();
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function connect(accountId = f.bank.id, autoPost = true) {
  const client = new FakePlaid();
  client.item.id = `item-${accountId}`;
  client.accountRows = [bankAccount(accountId, accountId === f.card.id ? "credit" : "depository")];
  const result = await exchangeConnection(
    h.db,
    f.ownerId,
    client,
    config,
    { public_token: "synthetic", institution: { institution_id: `ins_${accountId}`, name: "Example Bank" } },
    now,
  );
  await saveMapping(
    h.db,
    f.ownerId,
    result.connection.id,
    config,
    { importFromDate: "2026-10-01", accounts: [{ id: result.accounts[0].id, accountId }] },
    now,
  );
  if (!autoPost) await setAutoPost(h.db, f.ownerId, result.connection.id, config, { autoPost: false });
  return { id: result.connection.id, accountId, client };
}
type Connection = Awaited<ReturnType<typeof connect>>;
function transaction(
  c: Connection,
  id: string,
  amount = "20",
  name = "EXAMPLE CAFE",
  extra: Partial<BankTransaction> = {},
) {
  return bankTransaction(id, { accountId: c.accountId, amount, name, merchantName: name, ...extra });
}
async function sync(c: Connection, added: BankTransaction[] = []) {
  c.client.page = () => ({
    accounts: c.client.accountRows,
    added,
    modified: [],
    removed: [],
    nextCursor: "cursor-done",
    hasMore: false,
    updateStatus: "HISTORICAL_UPDATE_COMPLETE",
  });
  return syncConnection(h.db, f.ownerId, c.id, c.client, config, now);
}
const input = (...connections: string[]) => ({ connections, from: "2026-09-01" });
const rows = () => h.db.select().from(s.importRows).where(eq(s.importRows.ownerId, f.ownerId));
const entries = () => h.db.select().from(s.journalEntries).where(eq(s.journalEntries.ownerId, f.ownerId));
async function neutral() {
  const sums = await h.db.execute<{ currency: string; sum: string }>(
    sql`select currency,sum(amount)::text as sum from postings where owner_id=${f.ownerId} group by currency`,
  );
  expect(sums.rows.every((row) => /^0(?:\.0+)?$/.test(row.sum))).toBe(true);
}
async function externalEntry(source: "manual" | "parser" | "csv" | "legacy", amount = "11") {
  const entry = await createEntry(h.db, f.ownerId, {
    ...(await buildPostings(h.db, f.ownerId, "expense", {
      fromAccountId: f.bank.id,
      amount,
      categoryId: f.category("购物"),
      eventDate: "2026-10-15",
      merchant: `Synthetic ${source}`,
      status: "confirmed",
    })),
    source: source === "parser" || source === "csv" ? "import" : source,
  });
  if (source === "parser" || source === "csv") {
    const [statement] = await h.db
      .insert(s.statements)
      .values({
        ownerId: f.ownerId,
        accountId: f.bank.id,
        fileSha256: source.padEnd(64, "0"),
        originalFilename: `synthetic.${source === "csv" ? "csv" : "pdf"}`,
        mime: source === "csv" ? "text/csv" : "application/pdf",
        sizeBytes: 10,
        status: "approved",
      })
      .returning();
    await h.db.insert(s.importRows).values({
      ownerId: f.ownerId,
      statementId: statement.id,
      rowIndex: 0,
      accountId: f.bank.id,
      source,
      sourceRowText: "SYNTHETIC",
      descriptionRaw: `Synthetic ${source}`,
      merchantNormalized: `synthetic ${source}`,
      amountRaw: `-${amount}`,
      amount: `-${amount}`,
      currency: "USD",
      direction: "charge",
      confidence: "1",
      rowSignature: `synthetic-${source}`,
      transactionDate: "2026-10-15",
      decision: "approve",
      journalEntryId: entry.id,
    });
  }
  return entry;
}

it("resets only Plaid-owned entries, exports recovery with 0600, and keeps Items/mappings/non-Plaid data", async () => {
  const c = await connect();
  await sync(c, [transaction(c, "expense")]);
  const originals = await Promise.all([
    externalEntry("manual"),
    externalEntry("parser", "12"),
    externalEntry("csv", "13"),
    externalEntry("legacy", "14"),
  ]);
  const manual = await createSnapshot(h.db, f.ownerId, {
    snapshotDate: "2026-10-20",
    label: "Synthetic manual",
    items: [{ accountId: f.bank.id, balanceNative: "600", currency: "USD" }],
  });
  await publishSnapshot(h.db, f.ownerId, manual.id);
  const programs = await ensurePrograms(h.db, f.ownerId);
  void programs;
  const [program] = await h.db
    .select()
    .from(s.loyaltyPrograms)
    .where(and(eq(s.loyaltyPrograms.ownerId, f.ownerId), eq(s.loyaltyPrograms.code, "AA")));
  const loyalty = await saveLoyaltyAccount(h.db, f.ownerId, { programId: program.id, name: "Synthetic AA" });
  const point = await createEvent(h.db, f.ownerId, {
    loyaltyAccountId: loyalty.id,
    eventDate: "2026-10-20",
    type: "earn",
    pointsDelta: "1000",
  });
  const before = await requireConnection(h.db, f.ownerId, c.id);
  const mappings = await h.db.select().from(s.bankConnectionAccounts);
  const plan = await planReset(h.db, f.ownerId, config, input(c.id), now);
  expect(plan.totals).toMatchObject({
    entries_deleted: 1,
    postings_deleted: 2,
    rows_deleted: 1,
    observations_deleted: 0,
  });
  expect(await entries()).toHaveLength(5);
  const result = await executeReset(h.db, f.ownerId, config, input(c.id), now);
  expect((await entries()).map((row) => row.id).sort()).toEqual(originals.map((row) => row.id).sort());
  expect(await h.db.select().from(s.loyaltyEvents)).toContainEqual(
    expect.objectContaining({ id: point.id, pointsDelta: 1000n }),
  );
  expect(await h.db.select().from(s.balanceSnapshots)).toContainEqual(
    expect.objectContaining({ id: manual.id, source: "manual" }),
  );
  const after = await requireConnection(h.db, f.ownerId, c.id);
  expect(after).toMatchObject({
    accessTokenEnc: before.accessTokenEnc,
    plaidItemId: before.plaidItemId,
    autoPost: true,
    lastSuccessAt: before.lastSuccessAt,
    status: "active",
    transactionsCursor: null,
    syncGeneration: before.syncGeneration + 1,
    importFromDate: "2026-09-01",
    benefitVersion: 0,
    matchingVersion: 0,
  });
  expect(
    (await h.db.select().from(s.bankConnectionAccounts)).map(({ updatedAt, ...row }) => {
      void updatedAt;
      return row;
    }),
  ).toEqual(
    mappings.map(({ updatedAt, ...row }) => {
      void updatedAt;
      return row;
    }),
  );
  expect(c.client.removed).toEqual([]);
  const [exportRow] = await h.db.select().from(s.bankResetExports);
  expect((await stat(resetFile(dir, f.ownerId, exportRow.storagePath!))).mode & 0o777).toBe(0o600);
  const recovery = new TextDecoder().decode(
    await readResetRecovery(h.db, f.ownerId, result.recovery.id, config, now),
  );
  expect(JSON.parse(recovery).entries).toHaveLength(1);
  for (const secret of [before.accessTokenEnc, c.client.accessToken, "accessTokenEnc", "transactionsCursor"])
    expect(recovery).not.toContain(secret);
  expect((await listResetExports(h.db, f.ownerId, now))[0].downloadUrl).toBe(result.recovery.downloadUrl);
  expect(await listResetExports(h.db, f.otherId, now)).toEqual([]);
  await expect(readResetRecovery(h.db, f.otherId, result.recovery.id, config, now)).rejects.toThrow("不存在");
  const logs = await h.db.select().from(s.auditLogs).where(eq(s.auditLogs.action, "bank.reset"));
  expect(logs).toHaveLength(1);
  expect(Object.keys(logs[0].changes!).sort()).toEqual([...resetCountKeys].sort());
  expect(logs[0].changes).toEqual(plan.totals);
  await neutral();
});

it("unlinks a surviving other-connection leg; resetting both deletes both paired sides", async () => {
  const bank = await connect();
  const card = await connect(f.card.id);
  await sync(bank, [transaction(bank, "pay-out", "35", "CARD PAYMENT", { primary: "LOAN_PAYMENTS" })]);
  await sync(card, [transaction(card, "pay-in", "-35", "PAYMENT THANK YOU", { primary: "LOAN_PAYMENTS" })]);
  const cardRow = (await rows()).find((row) => row.accountId === f.card.id)!;
  const otherBefore = await requireConnection(h.db, f.ownerId, card.id);
  expect((await getEntry(h.db, f.ownerId, cardRow.journalEntryId!)).transferMatchId).toBeTruthy();
  const preview = await planReset(h.db, f.ownerId, config, input(bank.id), now);
  expect(preview.totals.transfer_links_unlinked).toBe(1);
  await executeReset(h.db, f.ownerId, config, input(bank.id), now);
  expect(await requireConnection(h.db, f.ownerId, card.id)).toEqual(otherBefore);
  expect(await getEntry(h.db, f.ownerId, cardRow.journalEntryId!)).toMatchObject({
    entryType: "transfer",
    transferMatchId: null,
    status: "confirmed",
  });
  expect(
    (await pendingWorkbench(h.db, f.ownerId, "sandbox")).transfers.some(
      (row) => row.id === cardRow.journalEntryId,
    ),
  ).toBe(true);
  await sync(bank, [transaction(bank, "pay-out", "35", "CARD PAYMENT", { primary: "LOAN_PAYMENTS" })]);
  expect(
    (await entries()).filter((row) => row.status === "confirmed").every((row) => row.transferMatchId),
  ).toBe(true);
  await executeReset(h.db, f.ownerId, config, input(bank.id, card.id), now);
  expect(await entries()).toEqual([]);
  expect(await rows()).toEqual([]);
  await sync(bank, [transaction(bank, "pay-out", "35", "CARD PAYMENT", { primary: "LOAN_PAYMENTS" })]);
  await sync(card, [transaction(card, "pay-in", "-35", "PAYMENT THANK YOU", { primary: "LOAN_PAYMENTS" })]);
  const matched = (await entries()).filter((entry) => entry.status === "confirmed");
  expect(matched).toHaveLength(2);
  expect(new Set(matched.map((entry) => entry.transferMatchId)).size).toBe(1);
  await sync(bank, [transaction(bank, "pay-out", "35", "CARD PAYMENT", { primary: "LOAN_PAYMENTS" })]);
  expect((await entries()).filter((entry) => entry.status === "confirmed")).toEqual(matched);
  expect(await rows()).toHaveLength(2);
  await neutral();
});

it("keeps the manual side of a match and clears manual refund/group links into deleted Plaid purchases", async () => {
  const c = await connect(f.card.id);
  await sync(c, [
    transaction(c, "payment", "-40", "PAYMENT THANK YOU", { primary: "LOAN_PAYMENTS" }),
    transaction(c, "purchase", "50", "EXAMPLE SHOP"),
  ]);
  const manual = await createQuickEntry(h.db, f.ownerId, {
    type: "expense",
    fromAccountId: f.bank.id,
    amount: "40",
    categoryId: f.category("购物"),
    eventDate: "2026-10-22",
    merchant: "Manual debit",
  });
  const payment = (await rows()).find((row) => row.providerTransactionId === "payment")!;
  await resolveEntryMatching(h.db, f.ownerId, payment.journalEntryId!, {
    action: "match",
    counterpartEntryId: manual.id,
  });
  const survivor = (await entries()).find((row) => row.replacesEntryId === manual.id)!;
  const purchase = (await rows()).find((row) => row.providerTransactionId === "purchase")!;
  const refund = await createQuickEntry(h.db, f.ownerId, {
    type: "refund",
    toAccountId: f.card.id,
    amount: "10",
    categoryId: f.category("购物"),
    refundOfEntryId: purchase.journalEntryId,
    eventDate: "2026-10-23",
  });
  const group = await createPurchaseGroup(h.db, f.ownerId, {
    title: "Synthetic purchase",
    currency: "USD",
    confirmedTotal: "50",
  });
  await linkGroupEntry(h.db, f.ownerId, group.id, purchase.journalEntryId!);
  const preview = await planReset(h.db, f.ownerId, config, input(c.id), now);
  expect(preview.totals).toMatchObject({
    transfer_links_unlinked: 1,
    refund_links_cleared: 1,
    purchase_group_links_removed: 1,
  });
  await executeReset(h.db, f.ownerId, config, input(c.id), now);
  expect(await getEntry(h.db, f.ownerId, survivor.id)).toMatchObject({
    source: "manual",
    status: "confirmed",
    entryType: "transfer",
    transferMatchId: null,
  });
  expect((await getEntry(h.db, f.ownerId, refund.id)).refundOfEntryId).toBeNull();
  expect(await h.db.select().from(s.purchaseGroups)).toHaveLength(1);
  expect(
    (await pendingWorkbench(h.db, f.ownerId, "sandbox")).transfers.some((row) => row.id === survivor.id),
  ).toBe(true);
  await neutral();
});

it.each([false, true])(
  "suggestion-created openings honor keepOpenings=%s; other openings always stay",
  async (keepOpenings) => {
    const c = await connect();
    await sync(c, [transaction(c, "expense")]);
    const opening = await confirmObservedOpening(h.db, f.ownerId, f.bank.id, { amount: "1020" });
    const other = await createQuickEntry(h.db, f.ownerId, {
      type: "opening_balance",
      toAccountId: f.bank.id,
      amount: "5",
      eventDate: "2026-01-01",
    });
    await executeReset(h.db, f.ownerId, config, { ...input(c.id), keepOpenings }, now);
    expect((await entries()).some((row) => row.id === opening.id)).toBe(keepOpenings);
    expect((await entries()).some((row) => row.id === other.id)).toBe(true);
  },
);

it.each([false, true])(
  "keeps manual observations and other-account items while deleteObservations=%s",
  async (deleteObservations) => {
    const a = await connect();
    const b = await connect(f.card.id);
    await sync(a);
    await sync(b);
    const manual = await createSnapshot(h.db, f.ownerId, {
      snapshotDate: "2026-10-20",
      label: "Synthetic manual",
      items: [{ accountId: f.bank.id, balanceNative: "30", currency: "USD" }],
    });
    await publishSnapshot(h.db, f.ownerId, manual.id);
    const prior = await h.db.select().from(s.snapshotItems);
    const observed = prior.filter((row) => row.accountId === f.bank.id && row.snapshotId !== manual.id);
    const protectedItems = prior.filter((row) => !observed.some((item) => item.id === row.id));
    await executeReset(h.db, f.ownerId, config, { ...input(a.id), deleteObservations }, now);
    const after = await h.db.select().from(s.snapshotItems);
    expect(after).toHaveLength(prior.length - (deleteObservations ? observed.length : 0));
    expect(after).toEqual(expect.arrayContaining(protectedItems));
  },
);

it("remembers an owner's edited category, reimports idempotently and keeps ledger balanced", async () => {
  const c = await connect();
  const transactions = [transaction(c, "cafe")];
  await sync(c, transactions);
  const original = await getEntry(h.db, f.ownerId, (await rows())[0].journalEntryId!);
  await updateEntryMeta(h.db, f.ownerId, original.id, {
    categories: [
      { postingId: original.postings.find((line) => line.categoryId)!.id, categoryId: f.category("教育") },
    ],
  });
  await executeReset(h.db, f.ownerId, config, input(c.id), now);
  expect(await rememberedCategory(h.db, f.ownerId, "Example Cafe", f.bank.id, "expense")).toBe(
    f.category("教育"),
  );
  expect((await h.db.select().from(s.merchantCategoryMemory))[0].source).toBe("owner_edited");
  const again = await executeReset(h.db, f.ownerId, config, input(c.id), now);
  expect(again.totals.entries_deleted).toBe(0);
  expect(again.totals.rows_deleted).toBe(0);
  await sync(c, transactions);
  await sync(c, transactions);
  expect(await rows()).toHaveLength(1);
  expect(await entries()).toHaveLength(1);
  const newEntry = await getEntry(h.db, f.ownerId, (await rows())[0].journalEntryId!);
  expect(newEntry.postings.find((line) => line.categoryId)?.categoryId).toBe(f.category("教育"));
  await executeReset(h.db, f.ownerId, config, input(c.id), now);
  expect((await h.db.select().from(s.merchantCategoryMemory))[0]).toMatchObject({
    source: "owner_edited",
    categoryId: f.category("教育"),
  });
  await sync(c, transactions);
  expect(await accountBalance(h.db, f.ownerId, f.bank.id, "2026-10-24")).toBe("-20.0000");
  await neutral();
});

it("a Plaid row linked as duplicate evidence never makes the PDF entry deletable", async () => {
  const pdf = await externalEntry("parser", "21");
  const c = await connect();
  await sync(c, [
    transaction(c, "duplicate", "21", "Synthetic parser", {
      date: "2026-10-15",
      authorizedDate: "2026-10-15",
    }),
  ]);
  expect((await rows()).find((row) => row.source === "plaid")).toMatchObject({
    linkedEntryId: pdf.id,
    autoPostState: "duplicate",
  });
  const result = await executeReset(h.db, f.ownerId, config, input(c.id), now);
  expect(result.totals.entries_deleted).toBe(0);
  expect((await entries()).map((row) => row.id)).toEqual([pdf.id]);
});

it("deletes Plaid review-approved entries and their owner replacement history", async () => {
  const c = await connect(f.bank.id, false);
  await sync(c, [transaction(c, "review")]);
  const row = (await rows())[0];
  await updateImportRows(h.db, f.ownerId, row.statementId, {
    rowIds: [row.id],
    changes: { decision: "approve", suggestedCategoryId: f.category("餐饮") },
  });
  const result = await approveRows(h.db, f.ownerId, row.statementId, {
    rowIds: [row.id],
    idempotencyKey: "reset-test",
  });
  const original = await getEntry(h.db, f.ownerId, result[0].entryId);
  await replaceEntry(
    h.db,
    f.ownerId,
    original.id,
    {
      ...(await buildPostings(h.db, f.ownerId, "expense", {
        fromAccountId: f.bank.id,
        amount: "21",
        categoryId: f.category("教育"),
        eventDate: "2026-10-22",
        status: "confirmed",
      })),
      source: "manual",
    },
    "Synthetic owner correction",
  );
  await executeReset(h.db, f.ownerId, config, input(c.id), now);
  expect(await entries()).toEqual([]);
  expect(await h.db.select().from(s.importApprovals)).toEqual([]);
  expect((await requireConnection(h.db, f.ownerId, c.id)).autoPost).toBe(false);
});

it("fences a network-in-flight old sync and does not let it restore the old cursor/date/rows", async () => {
  const c = await connect();
  let signal!: () => void;
  const started = new Promise<void>((resolve) => (signal = resolve));
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => (resume = resolve));
  c.client.page = async () => {
    signal();
    await gate;
    return {
      accounts: c.client.accountRows,
      added: [transaction(c, "stale")],
      modified: [],
      removed: [],
      nextCursor: "stale-cursor",
      hasMore: false,
      updateStatus: "HISTORICAL_UPDATE_COMPLETE",
    };
  };
  const old = syncConnection(h.db, f.ownerId, c.id, c.client, config, now).then(
    () => null,
    (error: unknown) => error,
  );
  await started;
  await executeReset(h.db, f.ownerId, config, input(c.id), now);
  resume();
  expect(await old).toMatchObject({ status: 409 });
  expect(await rows()).toEqual([]);
  expect(await requireConnection(h.db, f.ownerId, c.id)).toMatchObject({
    transactionsCursor: null,
    importFromDate: "2026-09-01",
    syncGeneration: 1,
  });
});

it("rejects cross-owner, wrong-env, revoked and illegal dates without deleting anything", async () => {
  const c = await connect();
  await sync(c, [transaction(c, "keep")]);
  await expect(planReset(h.db, f.otherId, config, input(c.id), now)).rejects.toThrow("活跃连接");
  await expect(
    planReset(h.db, f.ownerId, { ...config, PLAID_ENV: "production" }, input(c.id), now),
  ).rejects.toThrow("活跃连接");
  for (const from of ["2020-01-01", "2026-10-25", "2026-02-30"])
    await expect(executeReset(h.db, f.ownerId, config, { ...input(c.id), from }, now)).rejects.toThrow();
  await h.db.update(s.bankConnections).set({ status: "revoked" }).where(eq(s.bankConnections.id, c.id));
  await expect(executeReset(h.db, f.ownerId, config, input(c.id), now)).rejects.toThrow("活跃连接");
  expect(await rows()).toHaveLength(1);
  expect(await entries()).toHaveLength(1);
});

it("CLI defaults to preview and execute uses the identical owner-scoped service", async () => {
  const c = await connect();
  await sync(c, [transaction(c, "cafe")]);
  const args = ["--owner", "ledger@example.com", "--connections", "all"];
  const preview = await runResetCli(h.db, config, args, now);
  expect(preview.mode).toBe("dry-run");
  expect(preview.from).toBe("2026-07-26");
  expect(await entries()).toHaveLength(1);
  expect(JSON.stringify(preview)).not.toContain("EXAMPLE");
  const result = await runResetCli(h.db, config, [...args, "--execute", "--keep-openings"], now);
  expect(result.mode).toBe("execute");
  expect(await entries()).toEqual([]);
});

it("failed recovery write or later SQL rolls back the entire reset", async () => {
  const c = await connect();
  await sync(c, [transaction(c, "cafe")]);
  const before = await entries();
  const conn = await requireConnection(h.db, f.ownerId, c.id);
  const blocked = join(dir, "not-a-directory");
  await writeFile(blocked, "synthetic");
  await expect(
    executeReset(h.db, f.ownerId, { ...config, DATA_DIR: blocked }, input(c.id), now),
  ).rejects.toThrow();
  expect(await entries()).toEqual(before);
  await h.db.execute(
    sql`alter table bank_reset_exports add constraint synthetic_reset_failure check (false)`,
  );
  try {
    await expect(executeReset(h.db, f.ownerId, config, input(c.id), now)).rejects.toThrow();
  } finally {
    await h.db.execute(sql`alter table bank_reset_exports drop constraint synthetic_reset_failure`);
  }
  expect(await entries()).toEqual(before);
  expect(await requireConnection(h.db, f.ownerId, c.id)).toEqual(conn);
  expect(await readdir(join(dir, "resets", f.ownerId))).toEqual([]);
});

it("expires recovery files without deleting the recovery audit or the ledger", async () => {
  const c = await connect();
  await sync(c, [transaction(c, "cafe")]);
  const result = await executeReset(h.db, f.ownerId, config, input(c.id), now);
  const after = new Date(now.getTime() + 31 * 86400000);
  await retainResetExports(h.db, config, after);
  expect(await listResetExports(h.db, f.ownerId, after)).toEqual([]);
  await expect(readResetRecovery(h.db, f.ownerId, result.recovery.id, config, after)).rejects.toThrow(
    "保留期",
  );
  expect(await readdir(join(dir, "resets", f.ownerId))).toEqual([]);
  expect(await h.db.select().from(s.bankResetExports)).toHaveLength(1);
});

it.each(["creator", "linked"])(
  "legacy shared payments preserve the non-selected evidence side when resetting %s",
  async (side) => {
    const bank = await connect(f.bank.id, false);
    const card = await connect(f.card.id, false);
    await sync(bank, [transaction(bank, "old-out", "60", "CARD PAYMENT", { primary: "LOAN_PAYMENTS" })]);
    await sync(card, [transaction(card, "old-in", "-60", "PAYMENT THANK YOU", { primary: "LOAN_PAYMENTS" })]);
    const bankRow = (await rows()).find((row) => row.accountId === f.bank.id)!;
    const cardRow = (await rows()).find((row) => row.accountId === f.card.id)!;
    const old = await createEntry(h.db, f.ownerId, {
      ...(await buildPostings(h.db, f.ownerId, "credit_card_payment", {
        fromAccountId: f.bank.id,
        toAccountId: f.card.id,
        amount: "60",
        eventDate: "2026-10-22",
        status: "confirmed",
      })),
      source: "import",
    });
    await h.db
      .update(s.importRows)
      .set({ journalEntryId: old.id, decision: "approve", autoPostState: "posted" })
      .where(eq(s.importRows.id, bankRow.id));
    await h.db
      .update(s.importRows)
      .set({ linkedEntryId: old.id, decision: "link_existing", autoPostState: "posted" })
      .where(eq(s.importRows.id, cardRow.id));
    const selected = side === "creator" ? bank : card;
    const kept = side === "creator" ? card : bank;
    if (side === "linked") {
      await replaceEntry(
        h.db,
        f.ownerId,
        old.id,
        {
          ...(await buildPostings(h.db, f.ownerId, "credit_card_payment", {
            fromAccountId: f.bank.id,
            toAccountId: f.card.id,
            amount: "65",
            eventDate: "2026-10-23",
            status: "confirmed",
          })),
          source: "import",
        },
        "Synthetic owner amount correction",
      );
    }
    const before = await requireConnection(h.db, f.ownerId, kept.id);
    await executeReset(h.db, f.ownerId, config, input(selected.id), now);
    expect(await requireConnection(h.db, f.ownerId, kept.id)).toEqual(before);
    const surviving = (await rows())[0];
    expect(surviving.bankConnectionId).toBe(kept.id);
    const entry = await getEntry(h.db, f.ownerId, surviving.journalEntryId!);
    expect(entry).toMatchObject({ status: "confirmed", entryType: "transfer", transferMatchId: null });
    expect(entry.postings.some((line) => line.accountId === selected.accountId)).toBe(false);
    expect(entry.postings.find((line) => line.accountId === kept.accountId)?.amount).toBe(
      side === "creator" ? "60.0000" : "-65.0000",
    );
    if (side === "linked")
      expect(entry).toMatchObject({ eventDate: "2026-10-23", autoPostOwnerEdited: true });
    await neutral();
  },
);

it("deletes an unsupported old counterposting, but retains a separately owner-assigned counterpart leg", async () => {
  const c = await connect(f.card.id, false);
  await sync(c, [transaction(c, "old-in", "-71", "PAYMENT THANK YOU", { primary: "LOAN_PAYMENTS" })]);
  const row = (await rows())[0];
  const old = await createEntry(h.db, f.ownerId, {
    ...(await buildPostings(h.db, f.ownerId, "credit_card_payment", {
      fromAccountId: f.bank.id,
      toAccountId: f.card.id,
      amount: "71",
      eventDate: "2026-10-22",
      status: "confirmed",
    })),
    source: "import",
  });
  await h.db
    .update(s.importRows)
    .set({ journalEntryId: old.id, decision: "approve" })
    .where(eq(s.importRows.id, row.id));
  const plan = await planReset(h.db, f.ownerId, config, input(c.id), now);
  expect(plan.totals.unsupported_counterparts_deleted).toBe(1);
  await executeReset(h.db, f.ownerId, config, input(c.id), now);
  expect(await entries()).toEqual([]);
  expect(await accountBalance(h.db, f.ownerId, f.bank.id, "2026-10-24")).toBe("0.0000");
  await setAutoPost(h.db, f.ownerId, c.id, config, { autoPost: true });
  await sync(c, [transaction(c, "assigned-in", "-71", "PAYMENT THANK YOU", { primary: "LOAN_PAYMENTS" })]);
  const leg = (await rows())[0];
  const assigned = await resolveEntryMatching(h.db, f.ownerId, leg.journalEntryId!, {
    action: "assign",
    accountId: f.bank.id,
  });
  const counterpart = (await entries()).find(
    (entry) => entry.transferMatchId === assigned.transferMatchId && entry.source === "manual",
  )!;
  await executeReset(h.db, f.ownerId, config, input(c.id), now);
  expect((await entries()).map((entry) => entry.id)).toEqual([counterpart.id]);
  expect((await getEntry(h.db, f.ownerId, counterpart.id)).transferMatchId).toBeNull();
  await neutral();
});

it("recognizes legacy suggestion timestamps exactly; ambiguous openings are preserved and replacements are tracked", async () => {
  const c = await connect();
  await sync(c);
  const opening = await confirmObservedOpening(h.db, f.ownerId, f.bank.id, { amount: "1000" });
  await h.db
    .delete(s.auditLogs)
    .where(and(eq(s.auditLogs.ownerId, f.ownerId), eq(s.auditLogs.action, "entry.observed_opening")));
  expect((await planReset(h.db, f.ownerId, config, input(c.id), now)).totals.suggested_openings_deleted).toBe(
    1,
  );
  const other = await createQuickEntry(h.db, f.ownerId, {
    type: "opening_balance",
    toAccountId: f.bank.id,
    amount: "2",
    eventDate: "2026-01-01",
  });
  await h.db.execute(
    sql`update journal_entries set created_at=(select created_at from journal_entries where id=${opening.id}) where id=${other.id}`,
  );
  expect((await planReset(h.db, f.ownerId, config, input(c.id), now)).totals).toMatchObject({
    suggested_openings_deleted: 0,
    other_openings_kept: 2,
  });
  // An explicit marker is unambiguous even when timestamp-only legacy detection cannot decide.
  await h.db.insert(s.auditLogs).values({
    ownerId: f.ownerId,
    actorUserId: f.ownerId,
    entityType: "journal_entry",
    entityId: opening.id,
    action: "entry.observed_opening",
    changes: {},
  });
  const replacement = await replaceEntry(
    h.db,
    f.ownerId,
    opening.id,
    await buildPostings(h.db, f.ownerId, "opening_balance", {
      toAccountId: f.bank.id,
      amount: "1001",
      eventDate: "2026-01-01",
      status: "confirmed",
    }),
    "Synthetic correction",
  );
  await executeReset(h.db, f.ownerId, config, input(c.id), now);
  expect((await entries()).map((row) => row.id)).toEqual([other.id]);
  expect((await entries()).some((row) => row.id === replacement.id)).toBe(false);
});

it("clears PDF duplicate/pairing caches and informational reward references without deleting them", async () => {
  const c = await connect();
  await sync(c, [transaction(c, "source")]);
  const plaidRow = (await rows())[0];
  const pdf = await externalEntry("parser", "22");
  const pdfRow = (await rows()).find((row) => row.source === "parser")!;
  await h.db
    .update(s.importRows)
    .set({
      duplicateCandidateEntryIds: [plaidRow.journalEntryId!],
      duplicateCandidateRowIds: [plaidRow.id],
      pairing: [
        { entryId: plaidRow.journalEntryId!, counterAccountId: f.bank.id, kind: "credit_card_payment" },
      ],
      decisionPayload: { pairEntryId: plaidRow.journalEntryId! },
    })
    .where(eq(s.importRows.id, pdfRow.id));
  await h.db.insert(s.importApprovals).values({
    ownerId: f.ownerId,
    statementId: pdfRow.statementId,
    idempotencyKey: "old-cache",
    rowSetHash: "synthetic",
    result: [{ rowId: pdfRow.id, entryId: plaidRow.journalEntryId! }],
  });
  await ensurePrograms(h.db, f.ownerId);
  const [program] = await h.db
    .select()
    .from(s.loyaltyPrograms)
    .where(and(eq(s.loyaltyPrograms.ownerId, f.ownerId), eq(s.loyaltyPrograms.code, "AA")));
  const account = await saveLoyaltyAccount(h.db, f.ownerId, { programId: program.id, name: "Synthetic AA" });
  const reward = await createEvent(h.db, f.ownerId, {
    loyaltyAccountId: account.id,
    eventDate: "2026-10-22",
    type: "earn",
    pointsDelta: "42",
    relatedJournalEntryId: plaidRow.journalEntryId,
  });
  await h.db
    .update(s.loyaltyEvents)
    .set({ statementId: plaidRow.statementId })
    .where(eq(s.loyaltyEvents.id, reward.id));
  const result = await executeReset(h.db, f.ownerId, config, input(c.id), now);
  expect((await rows())[0]).toMatchObject({
    id: pdfRow.id,
    journalEntryId: pdf.id,
    duplicateCandidateEntryIds: [],
    duplicateCandidateRowIds: [],
    pairing: [],
    decisionPayload: {},
  });
  expect((await h.db.select().from(s.loyaltyEvents))[0]).toMatchObject({
    id: reward.id,
    pointsDelta: 42n,
    relatedJournalEntryId: null,
    statementId: null,
  });
  expect(await h.db.select().from(s.importApprovals)).toEqual([]);
  const recovery = JSON.parse(
    new TextDecoder().decode(await readResetRecovery(h.db, f.ownerId, result.recovery.id, config, now)),
  );
  expect(recovery.linksBefore.rewards[0].relatedJournalEntryId).toBe(plaidRow.journalEntryId);
});

it("reset fences a queued/running worker lease and queues exactly one replacement per connection", async () => {
  const c = await connect();
  const job = await claimJob(h.db, "synthetic-worker", now, true);
  expect(job?.connectionId).toBe(c.id);
  await executeReset(h.db, f.ownerId, config, input(c.id), now);
  await expect(syncConnection(h.db, f.ownerId, c.id, c.client, config, now, job!)).rejects.toThrow(
    "代次已过期",
  );
  const live = await h.db
    .select()
    .from(s.importJobs)
    .where(and(eq(s.importJobs.connectionId, c.id), eq(s.importJobs.status, "queued")));
  expect(live).toHaveLength(1);
  expect(live[0].syncGeneration).toBe(1);
});

it("resets an unmapped active connection without a failing job; mapping later queues the new generation", async () => {
  const client = new FakePlaid();
  const connected = await exchangeConnection(
    h.db,
    f.ownerId,
    client,
    config,
    { public_token: "synthetic", institution: { institution_id: "ins_unmapped", name: "Example Bank" } },
    now,
  );
  const result = await executeReset(h.db, f.ownerId, config, input(connected.connection.id), now);
  expect(result.jobs).toEqual([]);
  expect(result.waitingForMapping).toEqual([connected.connection.id]);
  expect(await h.db.select().from(s.importJobs)).toEqual([]);
  await saveMapping(
    h.db,
    f.ownerId,
    connected.connection.id,
    config,
    { importFromDate: result.from, accounts: [{ id: connected.accounts[0].id, accountId: f.bank.id }] },
    now,
  );
  const [job] = await h.db.select().from(s.importJobs);
  expect(job).toMatchObject({ kind: "plaid_sync", syncGeneration: 1, status: "queued" });
  expect(client.cursors).toEqual([]);
  expect(client.removed).toEqual([]);
});

it("preview includes ambiguous ordinary transfer candidates and moved-account replacement history", async () => {
  const bank = await connect();
  const card = await connect(f.card.id);
  await sync(bank, [
    transaction(bank, "ambiguous-a", "32", "Zelle transfer"),
    transaction(bank, "ambiguous-b", "32", "Zelle transfer"),
  ]);
  await sync(card, [transaction(card, "incoming", "-32", "PAYMENT THANK YOU", { primary: "LOAN_PAYMENTS" })]);
  const workbench = await pendingWorkbench(h.db, f.ownerId, "sandbox");
  const all = await planReset(h.db, f.ownerId, config, { connections: "all" }, now);
  expect(workbench.count).toBeGreaterThan(0);
  expect(workbench.suggestions).toHaveLength(2);
  // Reset counts deleted rows/legs; computed suggestion pairs are not separate ledger records.
  expect(all.totals.pending_deleted).toBe(workbench.count - workbench.suggestions.length);
  const prior = (await rows()).find((row) => row.bankConnectionId === bank.id)!;
  const replacement = await replaceEntry(
    h.db,
    f.ownerId,
    prior.journalEntryId!,
    await buildPostings(h.db, f.ownerId, "expense", {
      fromAccountId: f.broker.id,
      amount: "32",
      eventDate: "2026-10-22",
      categoryId: f.category("购物"),
      status: "confirmed",
    }),
    "Synthetic account correction",
  );
  const plan = await planReset(h.db, f.ownerId, config, input(bank.id), now);
  expect(plan.connections[0].counts.entries_deleted).toBe(plan.totals.entries_deleted);
  expect(
    plan.connections[0].accounts.find((account) => account.accountId === f.broker.id)?.counts.entries_deleted,
  ).toBe(1);
  await executeReset(h.db, f.ownerId, config, input(bank.id), now);
  expect((await entries()).some((entry) => entry.id === replacement.id)).toBe(false);
});

async function request(ownerId: string, body: unknown, origin = true) {
  const session = await createSession(h.db, ownerId, { ipHash: "synthetic", userAgent: "reset-test" });
  return new NextRequest("http://localhost:3000/api/plaid/reset", {
    method: "POST",
    headers: {
      cookie: `al_session=${session.token}`,
      host: "localhost:3000",
      origin: origin ? "http://localhost:3000" : "https://invalid.example",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
it("API enforces auth, origin, typed confirmation and recovery ownership; UI exposes the preview controls", async () => {
  const c = await connect();
  await sync(c, [transaction(c, "cafe")]);
  const unauth = new NextRequest("http://localhost:3000/api/plaid/reset", {
    method: "POST",
    headers: { host: "localhost:3000", origin: "http://localhost:3000" },
    body: JSON.stringify(input(c.id)),
  });
  expect((await resetRoute.POST(unauth)).status).toBe(401);
  expect((await resetRoute.POST(await request(f.ownerId, input(c.id), false))).status).toBe(403);
  expect(
    (await resetRoute.POST(await request(f.ownerId, { ...input(c.id), execute: true, confirmation: "yes" })))
      .status,
  ).toBe(400);
  const response = await resetRoute.POST(
    await request(f.ownerId, { ...input(c.id), execute: true, confirmation: "重置" }),
  );
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  const otherSession = await createSession(h.db, f.otherId, { ipHash: "synthetic", userAgent: "reset-test" });
  const download = new NextRequest(`http://localhost:3000/api/plaid/resets/${result.recovery.id}/recovery`, {
    headers: { cookie: `al_session=${otherSession.token}` },
  });
  expect(
    (await recoveryRoute.GET(download, { params: Promise.resolve({ id: result.recovery.id }) })).status,
  ).toBe(404);
  const html = renderToStaticMarkup(
    <ResetPreview plan={result} names={{ [c.id]: "Example Bank", [f.bank.id]: "Synthetic Checking" }} />,
  );
  expect(html).toContain("将删除");
  expect(html).toContain("观察");
  expect(renderToStaticMarkup(<ResetForm connectionIds={[c.id]} names={{}} />)).toContain("重置导入数据");
  const connections = await listConnections(h.db, f.ownerId);
  const view = renderToStaticMarkup(
    <ConnectionsView
      connections={jsonSafe(connections)}
      accounts={[]}
      environment="sandbox"
      interval={12}
      timezone="America/Los_Angeles"
    />,
  );
  expect(view).toContain("重置全部连接");
  expect(view).toContain("重置导入数据");
  vi.stubEnv("PLAID_ENABLED", "false");
  expect((await resetRoute.POST(await request(f.ownerId, input(c.id)))).status).toBe(404);
});
