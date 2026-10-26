import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  importRows,
  statements,
  journalEntries,
  snapshotItems,
  balanceSnapshots,
  importJobs,
  users,
  accounts,
  auditLogs,
  bankSyncRuns,
} from "@/db/schema";
import {
  createLinkToken,
  exchangeConnection,
  requireConnection,
  saveMapping,
  listConnections,
  queueSync,
  mappingSuggestions,
  removeConnection,
  scheduleSyncs,
} from "@/lib/bank-sync/connections";
import { collectSync, syncConnection, classifyTransaction } from "@/lib/bank-sync/sync";
import { setAutoPost } from "@/lib/bank-sync/pending";
import { processBankJob } from "@/lib/bank-sync/jobs";
import { claimJob } from "@/lib/imports/jobs";
import { decryptSecret } from "@/lib/auth/crypto";
import { createSession } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { exportOwnerData, exportOwnerCsv } from "@/lib/data/export";
import { deleteOwnerData, DELETE_CONFIRMATION } from "@/lib/data/delete";
import { updateImportRows } from "@/lib/imports/review";
import { approveRows } from "@/lib/imports/approval";
import { getEntry, createEntry } from "@/lib/ledger/entries";
import { buildPostings } from "@/lib/ledger/builders";
import { money } from "@/lib/money";
import { createAccount } from "@/lib/ledger/accounts";
import { latestSyncedBalances } from "@/lib/bank-sync/observations";
import { CORE_SWEEP_NOTE, isCoreSweep } from "@/lib/bank-sync/core-sweeps";
let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
let client: FakePlaid;
let dir: string;
const now = new Date("2026-10-24T12:00:00Z");
vi.mock("@/db/client", () => ({ getDb: () => h.db }));
vi.mock("@/lib/bank-sync/plaid-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bank-sync/plaid-client")>()),
  PlaidClient: class {
    constructor() {
      return client;
    }
  },
}));
const links = await import("@/app/api/plaid/link-token/route");
const listed = await import("@/app/api/plaid/connections/route");
const exchangedRoute = await import("@/app/api/plaid/exchange/route");
const removedRoute = await import("@/app/api/plaid/connections/[id]/route");
beforeAll(async () => {
  h = await createTestDb();
  dir = await mkdtemp(join(tmpdir(), "plaid-synthetic-"));
  for (const [key, value] of Object.entries(config)) vi.stubEnv(key, String(value));
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic/test");
});
afterAll(async () => {
  await h.client.close();
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
  client = new FakePlaid();
  vi.stubEnv("PLAID_ENABLED", "true");
});
async function connect(fake = client, ownerId = f.ownerId, mapping = true) {
  const result = await exchangeConnection(
    h.db,
    ownerId,
    fake,
    config,
    {
      public_token: "public-sandbox-synthetic",
      institution: { institution_id: "ins_synthetic", name: "Example Bank" },
      // Sync fixtures deliberately use multiple Items at one synthetic institution.
      allowDuplicate: true,
    },
    now,
  );
  if (mapping)
    await saveMapping(
      h.db,
      ownerId,
      result.connection.id,
      config,
      {
        importFromDate: "2026-10-01",
        accounts: result.accounts.map((row) => ({
          id: row.id,
          accountId: row.type === "credit" ? f.card.id : row.type === "investment" ? f.broker.id : f.bank.id,
          securityAccountId: row.type === "investment" ? f.security.id : null,
          isEnabled: true,
        })),
      },
      now,
    );
  // These original import/approval tests deliberately exercise review mode.
  await setAutoPost(h.db, ownerId, result.connection.id, config, { autoPost: false });
  return result.connection.id;
}
const rows = () =>
  h.db.select().from(importRows).where(eq(importRows.ownerId, f.ownerId)).orderBy(importRows.rowIndex);
const page = (
  added: ReturnType<typeof bankTransaction>[] = [],
  changes: Partial<Awaited<ReturnType<FakePlaid["sync"]>>> = {},
) => ({
  accounts: client.accountRows,
  added,
  modified: [],
  removed: [],
  nextCursor: "cursor-1",
  hasMore: false,
  updateStatus: "HISTORICAL_UPDATE_COMPLETE",
  ...changes,
});
async function approve(row: typeof importRows.$inferSelect, changes: Record<string, unknown> = {}) {
  await updateImportRows(h.db, f.ownerId, row.statementId, {
    rowIds: [row.id],
    changes: { decision: "approve", ...changes },
  });
  return approveRows(h.db, f.ownerId, row.statementId, {
    rowIds: [row.id],
    idempotencyKey: `approve-${row.id}`,
  });
}
it("creates distinct product link tokens, opaque users, optional redirect and product-free update mode", async () => {
  await createLinkToken(h.db, f.ownerId, client, config, "transactions");
  await createLinkToken(
    h.db,
    f.ownerId,
    client,
    { ...config, PLAID_REDIRECT_URI: "https://example.test/plaid/oauth" },
    "investments",
  );
  const id = await connect();
  await createLinkToken(h.db, f.ownerId, client, config, "transactions", id);
  expect(client.linkRequests[0]).toMatchObject({
    products: ["transactions"],
    language: "en",
    country_codes: ["US"],
    transactions: { days_requested: 90 },
  });
  expect(client.linkRequests[0].user.client_user_id).not.toContain(f.ownerId);
  expect(client.linkRequests[0]).not.toHaveProperty("redirect_uri");
  expect(client.linkRequests[1]).toMatchObject({
    products: ["investments"],
    redirect_uri: "https://example.test/plaid/oauth",
  });
  expect(client.linkRequests[1]).not.toHaveProperty("transactions");
  expect(client.linkRequests[2]).toHaveProperty("access_token", client.accessToken);
  expect(client.linkRequests[2]).not.toHaveProperty("products");
});
it("encrypts credentials, limits suggestions to owned compatible currencies, excludes secrets from JSON/CSV", async () => {
  await h.db.update(accounts).set({ last4: "1234" }).where(eq(accounts.id, f.bank.id));
  await h.db.update(accounts).set({ last4: "1234" }).where(eq(accounts.id, f.wallet.id));
  const id = await connect(client, f.ownerId, false);
  const connection = await requireConnection(h.db, f.ownerId, id);
  expect(connection.accessTokenEnc).not.toContain(client.accessToken);
  expect(decryptSecret(connection.accessTokenEnc, config.APP_SECRET, "plaid-access-token")).toBe(
    client.accessToken,
  );
  expect(() => decryptSecret(connection.accessTokenEnc, config.APP_SECRET)).toThrow();
  const suggestions = await mappingSuggestions(h.db, f.ownerId, id);
  expect(suggestions.find((row) => row.type === "depository")!.suggestions.map((row) => row.id)).toEqual([
    f.bank.id,
  ]);
  const exported = JSON.stringify(await exportOwnerData(h.db, f.ownerId));
  const csv = await exportOwnerCsv(h.db, f.ownerId, "bank_connections");
  for (const value of [exported, csv, JSON.stringify(await listConnections(h.db, f.ownerId))]) {
    expect(value).not.toContain(client.accessToken);
    expect(value).not.toContain(connection.accessTokenEnc);
    expect(value).not.toContain("accessTokenEnc");
  }
});
it("collects pages before atomic apply, skips pending/date/unofficial rows and re-syncs idempotently", async () => {
  const id = await connect();
  client.page = (cursor) =>
    cursor === "page-1"
      ? page([bankTransaction("posted", { accountId: "card", pendingTransactionId: "pending" })], {
          nextCursor: "done",
        })
      : page(
          [
            bankTransaction("pending", { pending: true }),
            bankTransaction("old", { date: "2026-09-30" }),
            bankTransaction("unofficial", { currency: null }),
            bankTransaction("cash"),
          ],
          { nextCursor: "page-1", hasMore: true },
        );
  const result = await syncConnection(h.db, f.ownerId, id, client, config, now);
  expect(result).toMatchObject({ added: 2, pendingSkipped: 1, beforeStartSkipped: 1, currencySkipped: 1 });
  expect((await rows()).map((row) => row.providerTransactionId).sort()).toEqual(["cash", "posted"]);
  expect((await requireConnection(h.db, f.ownerId, id)).transactionsCursor).toBe("done");
  expect(await h.db.select().from(statements)).toHaveLength(1);
  client.page = () =>
    page([bankTransaction("posted", { accountId: "card" }), bankTransaction("cash")], {
      nextCursor: "done-2",
    });
  await syncConnection(h.db, f.ownerId, id, client, config, new Date(now.getTime() + 1000));
  expect(await rows()).toHaveLength(2);
  expect(await h.db.select().from(journalEntries)).toHaveLength(0);
});
it.each([
  ["REDEMPTION FROM CORE ACCOUNT (SPAXX)", true],
  ["REDEEM SPAXX", true],
  ["redeemed (spaxx)", true],
  ["PURCHASE INTO CORE ACCOUNT (SPAXX)", true],
  ["PURCHASED SPAXX", true],
  ["YOU BOUGHT SPAXX", true],
  ["YOU SOLD SPAXX", true],
  ["REINVESTMENT (SPAXX)", true],
  ["REINVEST SPAXX", true],
  ["DIVIDEND RECEIVED (SPAXX)", false],
  ["PURCHASE AT EXAMPLE STORE", false],
  ["PURCHASE SPAXXY", false],
  ["REDEMPTION ASPAXX", false],
])("recognizes core sweeps: %s", (description, expected) => {
  expect(isCoreSweep(description)).toBe(expected);
});
it("skips SPAXX sweeps across raw Plaid fields, persists safe counts and retains dividend income", async () => {
  const id = await connect();
  client.page = () =>
    page([
      bankTransaction("redeem", {
        name: "REDEMPTION FROM CORE ACCOUNT (SPAXX)",
        originalDescription: "Synthetic core activity",
        merchantName: "Example Brokerage",
        amount: "-60",
      }),
      bankTransaction("purchase", { originalDescription: "PURCHASE INTO CORE ACCOUNT (SPAXX)" }),
      bankTransaction("normal"),
    ]);
  expect(await syncConnection(h.db, f.ownerId, id, client, config, now)).toMatchObject({
    added: 1,
    coreSweepSkipped: 2,
  });
  expect((await rows()).map((row) => row.providerTransactionId)).toEqual(["normal"]);
  const [run] = await h.db.select().from(bankSyncRuns).where(eq(bankSyncRuns.connectionId, id));
  expect(run.counts).toMatchObject({ imported: 1, core_sweep_skipped: 2 });
  const [statement] = await h.db.select().from(statements);
  expect(statement.diagnostics).toContainEqual({ kind: "coreSweepSkipped", count: 2, severity: "info" });
  await setAutoPost(h.db, f.ownerId, id, config, { autoPost: true });
  client.page = () =>
    page([
      bankTransaction("dividend", { name: "DIVIDEND RECEIVED (SPAXX)", amount: "-2", primary: "INCOME" }),
    ]);
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  const dividend = (await rows()).find((row) => row.providerTransactionId === "dividend")!;
  expect(await getEntry(h.db, f.ownerId, dividend.journalEntryId!)).toMatchObject({
    entryType: "income",
    status: "confirmed",
  });
});
it("excludes an unposted upstream sweep with its specific soft note", async () => {
  const id = await connect();
  client.page = () => page([bankTransaction("changed")]);
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  const [before] = await rows();
  await h.db
    .update(importRows)
    .set({
      autoPostState: "duplicate",
      duplicateCandidateRowIds: [crypto.randomUUID()],
      duplicateCandidateEntryIds: [crypto.randomUUID()],
    })
    .where(eq(importRows.id, before.id));
  client.page = () =>
    page([], {
      modified: [
        bankTransaction("changed", {
          originalDescription: "PURCHASE INTO CORE ACCOUNT",
          merchantName: "SPAXX",
        }),
      ],
    });
  expect(await syncConnection(h.db, f.ownerId, id, client, config, now)).toMatchObject({
    coreSweepSkipped: 1,
  });
  expect((await rows())[0]).toMatchObject({
    decision: "exclude",
    autoPostState: "resolved",
    duplicateCandidateRowIds: [],
    duplicateCandidateEntryIds: [],
    journalEntryId: null,
    softNotes: [CORE_SWEEP_NOTE],
  });
});
it.each([
  ["RENT_AND_UTILITIES_RENT", "住房租金"],
  ["RENT_AND_UTILITIES_TELEPHONE", "水电网络"],
  ["RENT_AND_UTILITIES_INTERNET_AND_CABLE", "水电网络"],
  ["RENT_AND_UTILITIES_GAS_AND_ELECTRICITY", "水电网络"],
])("classifies %s without confusing its primary category prefix for rent", (detailed, category) => {
  expect(
    classifyTransaction(
      bankTransaction("synthetic-bill", {
        primary: "RENT_AND_UTILITIES",
        detailed,
      }),
      "credit",
    ),
  ).toMatchObject({ type: "expense", category });
});
it("does not treat adding the raw name to a legacy payload as an upstream modification", async () => {
  const id = await connect();
  client.page = () => page([bankTransaction("legacy")]);
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  const [row] = await rows();
  const legacyPayload = { ...row.upstreamPayload };
  delete legacyPayload.name;
  await h.db.update(importRows).set({ upstreamPayload: legacyPayload }).where(eq(importRows.id, row.id));
  client.page = () => page([], { modified: [bankTransaction("legacy")] });
  expect(await syncConnection(h.db, f.ownerId, id, client, config, now)).toMatchObject({ modified: 0 });
  expect((await rows())[0].upstreamState).toBe("none");
});
it("restarts mutation pagination at the original cursor and leaves rows/cursor unchanged after persistent mid-page failure", async () => {
  const id = await connect();
  await h.db
    .update(bankConnections)
    .set({ transactionsCursor: "original" })
    .where(eq(bankConnections.id, id));
  client.page = (cursor, call) => {
    if (call === 2) throw plaidFailure("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION");
    return cursor === "original"
      ? page([bankTransaction("first")], { hasMore: true, nextCursor: "middle" })
      : page([bankTransaction("second")], { nextCursor: "complete" });
  };
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  expect(client.cursors).toEqual(["original", "middle", "original", "middle"]);
  expect(await rows()).toHaveLength(2);
  client.cursors = [];
  client.page = (cursor) => {
    if (cursor === "broken-middle") throw plaidFailure("INSTITUTION_DOWN");
    return page([bankTransaction("never-applied")], { hasMore: true, nextCursor: "broken-middle" });
  };
  await expect(syncConnection(h.db, f.ownerId, id, client, config, now)).rejects.toMatchObject(
    plaidFailure("INSTITUTION_DOWN"),
  );
  expect(client.cursors).toEqual([
    "complete",
    "broken-middle",
    "complete",
    "broken-middle",
    "complete",
    "broken-middle",
    "complete",
    "broken-middle",
  ]);
  expect(await rows()).toHaveLength(2);
  expect((await requireConnection(h.db, f.ownerId, id)).transactionsCursor).toBe("complete");
});
it("rolls back the entire applied batch and cursor if a later row fails validation", async () => {
  const id = await connect();
  client.page = () => page([bankTransaction("valid"), bankTransaction("invalid", { date: "2026-99-99" })]);
  await expect(syncConnection(h.db, f.ownerId, id, client, config, now)).rejects.toThrow();
  expect(await rows()).toHaveLength(0);
  expect(await h.db.select().from(statements)).toHaveLength(0);
  expect((await requireConnection(h.db, f.ownerId, id)).transactionsCursor).toBeNull();
});
it("NOT_READY preserves the committed cursor and retries later", async () => {
  const id = await connect();
  client.page = () => page([], { nextCursor: "", updateStatus: "NOT_READY" });
  const job = await claimJob(h.db, "worker-a", now, true);
  await processBankJob(h.db, job!, client, config, now);
  const [updated] = await h.db.select().from(importJobs).where(eq(importJobs.id, job!.id));
  expect(updated.status).toBe("queued");
  expect(updated.runAfter.getTime()).toBeGreaterThan(now.getTime());
  expect((await requireConnection(h.db, f.ownerId, id)).transactionsCursor).toBeNull();
  expect(await rows()).toHaveLength(0);
});
it("normalizes cash/card signs and classifies PFC without approving", async () => {
  const id = await connect();
  const transactions = [
    bankTransaction("debit"),
    bankTransaction("income", { amount: "-500.0000", primary: "INCOME", detailed: "INCOME_WAGES" }),
    bankTransaction("charge", { accountId: "card" }),
    bankTransaction("refund", { accountId: "card", amount: "-10.0000" }),
    bankTransaction("payment", {
      accountId: "card",
      name: "AUTOPAY PAYMENT",
      amount: "-50.0000",
      primary: "LOAN_PAYMENTS",
      detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
    }),
  ];
  client.page = () => page(transactions);
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  const imported = await rows();
  expect(imported.map((row) => row.amount)).toEqual([
    "-20.0000",
    "500.0000",
    "-20.0000",
    "10.0000",
    "50.0000",
  ]);
  expect(imported.map((row) => row.suggestedEntryType)).toEqual([
    "expense",
    "income",
    "expense",
    "refund",
    "credit_card_payment",
  ]);
  expect(imported.every((row) => row.decision === "pending")).toBe(true);
  expect(
    classifyTransaction(
      bankTransaction("transfer", { primary: "TRANSFER_IN", amount: "-5.0000" }),
      "depository",
    ).type,
  ).toBe("transfer");
});
it("classifies depository deposits by payroll, income PFC, transfer, refund, then other income", async () => {
  const cases = [
    { name: "Sweetgreen inc payroll ppd id", category: "工资" },
    { name: "EXAMPLE DIRECT DEP", category: "工资" },
    { name: "Example direct deposit", category: "工资" },
    { name: "EXAMPLE SALARY", category: "工资" },
    { name: "Example ppd id", category: "工资" },
    { name: "EXAMPLE PAYROLL", primary: "TRANSFER_IN", category: "工资" },
    { name: "EXAMPLE REFUND", primary: "INCOME", detailed: "INCOME_WAGES", category: "工资" },
    { name: "EXAMPLE INTEREST", primary: "INCOME", detailed: "INCOME_INTEREST_EARNED", category: "利息收入" },
    { name: "EXAMPLE RETURN", primary: "TRANSFER_IN", type: "transfer", category: null },
    { name: "EXAMPLE PURCHASE REFUND", type: "refund", category: "其他支出" },
    { name: "Example merchandise return", type: "refund", category: "其他支出" },
    { name: "EXAMPLE DEPOSIT", category: "其他收入" },
    { name: "EXAMPLE CREDIT", originalDescription: "Employer direct dep ppd id", category: "工资" },
  ];
  const transactions = cases.map((sample, index) =>
    bankTransaction(`deposit-${index}`, {
      amount: "-100.0000",
      name: sample.name,
      merchantName: sample.name,
      primary: sample.primary ?? "FOOD_AND_DRINK",
      detailed: sample.detailed ?? "FOOD_AND_DRINK_RESTAURANT",
      originalDescription: sample.originalDescription ?? null,
    }),
  );
  const id = await connect();
  client.page = () => page(transactions);
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  const imported = await rows();
  expect(imported).toHaveLength(cases.length);
  for (const [index, sample] of cases.entries()) {
    expect(imported[index], sample.name).toMatchObject({
      suggestedEntryType: sample.type ?? "income",
      suggestedCategoryId: sample.category ? f.category(sample.category) : null,
      direction: sample.type === "refund" ? "refund" : "transfer_in",
      amount: "100.0000",
      decision: "pending",
    });
  }
  expect(classifyTransaction(transactions[0], "credit")).toMatchObject({ type: "refund" });
  expect(
    classifyTransaction(
      bankTransaction("card-payment", { name: "AUTOPAY PAYMENT", amount: "-100" }),
      "credit",
    ),
  ).toMatchObject({ type: "credit_card_payment" });
  expect(await h.db.select().from(journalEntries)).toHaveLength(0);
});
it("updates unapproved rows with audit but only flags confirmed entry evidence for modified/removed", async () => {
  const id = await connect();
  client.page = () => page([bankTransaction("unapproved"), bankTransaction("approved")]);
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  const [unapproved, approved] = await rows();
  const [created] = await approve(approved);
  client.page = () =>
    page([], {
      modified: [
        bankTransaction("unapproved", { amount: "30.0000" }),
        bankTransaction("approved", { amount: "40.0000" }),
      ],
      nextCursor: "modified",
    });
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  const changed = await rows();
  expect(changed[0].amount).toBe("-30.0000");
  expect(changed[1].amount).toBe("-20.0000");
  expect(changed[1].upstreamState).toBe("modified");
  expect((await getEntry(h.db, f.ownerId, created.entryId)).upstream[0].state).toBe("modified");
  client.page = () => page([], { removed: ["unapproved", "approved"], nextCursor: "removed" });
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  const removed = await rows();
  expect(removed.find((row) => row.id === unapproved.id)!.decision).toBe("exclude");
  expect(removed[1].upstreamState).toBe("removed");
  const entry = await getEntry(h.db, f.ownerId, created.entryId);
  expect(entry.status).toBe("confirmed");
  expect(entry.postings.find((line) => line.accountId === f.bank.id)!.amount).toBe("-20.0000");
  expect(await h.db.select().from(auditLogs).where(eq(auditLogs.action, "bank.row_modified"))).toHaveLength(
    1,
  );
});
it("flags PDF overlap without merging and preserves merchant-history category over PFC", async () => {
  const existing = await createEntry(h.db, f.ownerId, {
    ...(await buildPostings(h.db, f.ownerId, "expense", {
      amount: "20.0000",
      fromAccountId: f.bank.id,
      categoryId: f.category("购物"),
      eventDate: "2026-10-22",
      merchant: "EXAMPLE CAFE",
      status: "confirmed",
    })),
    source: "import",
  });
  const [pdf] = await h.db
    .insert(statements)
    .values({
      ownerId: f.ownerId,
      source: "upload",
      accountId: f.bank.id,
      fileSha256: "a".repeat(64),
      originalFilename: "synthetic.pdf",
      mime: "application/pdf",
      sizeBytes: 100,
      status: "approved",
    })
    .returning();
  await h.db.insert(importRows).values({
    ownerId: f.ownerId,
    statementId: pdf.id,
    rowIndex: 0,
    sourceRowText: "EXAMPLE CAFE",
    descriptionRaw: "EXAMPLE CAFE",
    merchantNormalized: "EXAMPLE CAFE",
    amountRaw: "20",
    amount: "-20.0000",
    currency: "USD",
    direction: "charge",
    confidence: "1",
    rowSignature: "synthetic-pdf",
    journalEntryId: existing.id,
    transactionDate: "2026-10-22",
  });
  const id = await connect();
  client.page = () => page([bankTransaction("plaid-duplicate")]);
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  const row = (await rows()).find((row) => row.source === "plaid")!;
  expect(row.duplicateCandidateEntryIds).toContain(existing.id);
  expect(row.duplicateResolution).toBe("none");
  expect(row.suggestedCategoryId).toBe(f.category("购物"));
  expect(await h.db.select().from(journalEntries)).toHaveLength(1);
});
it("pairs payments across connections into one confirmed entry and no spending", async () => {
  client.accountRows = [bankAccount("bank")];
  const bankId = await connect();
  client.page = () =>
    page([
      bankTransaction("bank-payment", {
        amount: "50.0000",
        name: "CARD PAYMENT",
        primary: "LOAN_PAYMENTS",
        detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
      }),
    ]);
  await syncConnection(h.db, f.ownerId, bankId, client, config, now);
  const cardClient = new FakePlaid();
  cardClient.item.id = "item-card";
  cardClient.accountRows = [bankAccount("card", "credit")];
  const cardId = await connect(cardClient);
  cardClient.page = () => ({
    ...page([
      bankTransaction("card-payment", { accountId: "card", amount: "-50.0000", name: "AUTOPAY PAYMENT" }),
    ]),
    accounts: cardClient.accountRows,
  });
  await syncConnection(h.db, f.ownerId, cardId, cardClient, config, now);
  const imported = await rows();
  const bank = imported.find((row) => row.providerTransactionId === "bank-payment")!;
  const card = imported.find((row) => row.providerTransactionId === "card-payment")!;
  expect(card.pairing.some((pair) => pair.rowId === bank.id)).toBe(true);
  const [result] = await approve(card, { decisionPayload: { pairRowId: bank.id } });
  expect(await h.db.select().from(journalEntries)).toHaveLength(1);
  const entry = await getEntry(h.db, f.ownerId, result.entryId);
  expect(entry.entryType).toBe("credit_card_payment");
  expect(entry.postings.reduce((sum, row) => sum.plus(money(row.amount)), money("0")).isZero()).toBe(true);
  expect(entry.postings.some((row) => row.accountId === f.expense.id)).toBe(false);
  expect((await rows()).every((row) => (row.journalEntryId ?? row.linkedEntryId) === entry.id)).toBe(true);
});
it("observes credit/depository signs and same-day versions without ledger entries", async () => {
  const id = await connect();
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  const first = await h.db.select().from(snapshotItems).orderBy(snapshotItems.balanceNative);
  expect(first.map((row) => row.balanceNative)).toEqual(["-200.0000", "1000.0000"]);
  client.accountRows[0].current = "900.0000";
  await syncConnection(h.db, f.ownerId, id, client, config, new Date(now.getTime() + 60000));
  const observations = await h.db.select().from(balanceSnapshots);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({ source: "plaid", status: "published", isComplete: false });
  const history = await h.db.select().from(snapshotItems);
  expect(history.filter((row) => row.isCurrent)).toHaveLength(2);
  expect(history.find((row) => row.accountId === f.bank.id && row.isCurrent)).toMatchObject({
    balanceNative: "900.0000",
    version: 2,
  });
  expect(
    history
      .filter((row) => !row.isCurrent)
      .map((row) => row.id)
      .sort(),
  ).toEqual(first.map((row) => row.id).sort());
  expect(await h.db.select().from(journalEntries)).toHaveLength(0);
});
it("maps loans to liabilities and versions negative balances while counting skipped loan transactions", async () => {
  const loan = await createAccount(h.db, f.ownerId, {
    name: "Example Loan",
    type: "liability_loan",
    currency: "USD",
    last4: "1234",
  });
  client.accountRows = [{ ...bankAccount("loan", "loan", "2500.0000"), subtype: "student" }];
  const id = await connect(client, f.ownerId, false);
  const [suggestion] = await mappingSuggestions(h.db, f.ownerId, id);
  expect(suggestion.suggestions.map((row) => row.id)).toEqual([loan.id]);
  await saveMapping(
    h.db,
    f.ownerId,
    id,
    config,
    {
      importFromDate: "2026-10-01",
      accounts: [{ id: suggestion.id, accountId: loan.id, securityAccountId: null, isEnabled: true }],
    },
    now,
  );
  client.page = () =>
    page([
      bankTransaction("loan-payment", { accountId: "loan", amount: "-100" }),
      bankTransaction("loan-charge", { accountId: "loan", amount: "20" }),
      bankTransaction("loan-pending", { accountId: "loan", pending: true }),
    ]);
  const result = await syncConnection(h.db, f.ownerId, id, client, config, now);
  expect(result).toMatchObject({ loanTransactionsSkipped: 3, added: 0 });
  expect((await h.db.select().from(statements))[0].diagnostics).toContainEqual({
    kind: "loanTransactionsSkipped",
    count: 3,
    severity: "info",
  });
  expect((await h.db.select().from(snapshotItems))[0]).toMatchObject({
    accountId: loan.id,
    balanceNative: "-2500.0000",
    version: 1,
  });
  expect((await latestSyncedBalances(h.db, f.ownerId))[0].balanceNative).toBe("-2500.0000");
  client.accountRows[0].current = "2400.0000";
  await syncConnection(h.db, f.ownerId, id, client, config, new Date(now.getTime() + 60000));
  const history = await h.db.select().from(snapshotItems);
  expect(history).toHaveLength(2);
  expect(history.find((row) => row.isCurrent)).toMatchObject({ balanceNative: "-2400.0000", version: 2 });
  expect((await latestSyncedBalances(h.db, f.ownerId))[0].balanceNative).toBe("-2400.0000");
  expect((await h.db.select().from(balanceSnapshots))[0]).toMatchObject({
    source: "plaid",
    status: "published",
    isComplete: false,
  });
  expect(await rows()).toHaveLength(0);
  expect(await h.db.select().from(journalEntries)).toHaveLength(0);
});
it("observes holdings market value and cash separately without importing investment transactions", async () => {
  client.item.products = ["investments"];
  client.accountRows = [bankAccount("invest", "investment", "1200.0000")];
  client.holdingsResult = {
    accounts: client.accountRows,
    holdings: [
      { accountId: "invest", value: "1000.0000", currency: "USD", cash: false },
      { accountId: "invest", value: "200.0000", currency: "USD", cash: true },
    ],
  };
  const id = await connect();
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  const items = await h.db.select().from(snapshotItems);
  expect(items.find((row) => row.accountId === f.security.id)!.balanceNative).toBe("1000.0000");
  expect(items.find((row) => row.accountId === f.broker.id)!.balanceNative).toBe("200.0000");
  expect(client.cursors).toHaveLength(0);
  expect(await rows()).toHaveLength(0);
});
it("marks ITEM_LOGIN_REQUIRED and enforces owner isolation, scheduling, per-minute requests and revoked retention", async () => {
  const id = await connect();
  await expect(requireConnection(h.db, f.otherId, id)).rejects.toMatchObject({ status: 404 });
  await queueSync(h.db, f.ownerId, id, config, true, now);
  await expect(queueSync(h.db, f.ownerId, id, config, true, now)).rejects.toMatchObject({ status: 409 });
  await scheduleSyncs(h.db, config, now);
  expect(await h.db.select().from(importJobs)).toHaveLength(1);
  client.page = () => {
    throw plaidFailure("ITEM_LOGIN_REQUIRED");
  };
  await expect(syncConnection(h.db, f.ownerId, id, client, config, now)).rejects.toMatchObject(
    plaidFailure("ITEM_LOGIN_REQUIRED"),
  );
  expect((await requireConnection(h.db, f.ownerId, id)).status).toBe("login_required");
  await removeConnection(h.db, f.ownerId, id, client, config);
  expect((await requireConnection(h.db, f.ownerId, id)).status).toBe("revoked");
  expect(await listConnections(h.db, f.ownerId)).toHaveLength(1);
  expect(client.removed).toEqual([client.accessToken]);
});
it("delete-all revokes active Items, preserves other owners, and keeps local records after remote failure", async () => {
  const password = "Synthetic-Delete-Plaid-2026";
  await h.db
    .update(users)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(users.id, f.ownerId));
  const id = await connect();
  const otherClient = new FakePlaid();
  otherClient.item.id = "other-item";
  await connect(otherClient, f.otherId, false);
  const request = { confirmation: DELETE_CONFIRMATION, password };
  const remove = vi.spyOn(client, "remove").mockRejectedValueOnce(plaidFailure("INSTITUTION_DOWN"));
  await expect(
    deleteOwnerData(h.db, f.ownerId, request, { ...config, DATA_DIR: dir }, now, client),
  ).rejects.toBeDefined();
  expect((await requireConnection(h.db, f.ownerId, id)).status).toBe("active");
  await deleteOwnerData(h.db, f.ownerId, request, { ...config, DATA_DIR: dir }, now, client);
  expect(remove).toHaveBeenCalledTimes(2);
  expect(await listConnections(h.db, f.ownerId)).toHaveLength(0);
  expect(await listConnections(h.db, f.otherId)).toHaveLength(1);
  expect(await h.db.select().from(users)).toHaveLength(2);
});
function request(
  path: string,
  method: string,
  token: string | null,
  body?: unknown,
  origin = "http://localhost:3000",
) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: {
      host: "localhost:3000",
      origin,
      "Content-Type": "application/json",
      ...(token ? { cookie: `al_session=${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
it("API requires auth/origin, hides disabled endpoints and never returns tokens", async () => {
  expect((await listed.GET(request("/api/plaid/connections", "GET", null))).status).toBe(401);
  const token = (await createSession(h.db, f.ownerId, { ipHash: "synthetic", userAgent: "test" })).token;
  expect(
    (
      await links.POST(
        request("/api/plaid/link-token", "POST", token, { product: "transactions" }, "https://evil.test"),
      )
    ).status,
  ).toBe(403);
  const response = await exchangedRoute.POST(
    request("/api/plaid/exchange", "POST", token, {
      public_token: "synthetic",
      institution: { institution_id: "ins_synthetic", name: "Example Bank" },
    }),
  );
  expect(response.status).toBe(200);
  const data = await response.text();
  expect(data).not.toContain(client.accessToken);
  expect(data).not.toContain("accessTokenEnc");
  const foreignToken = (await createSession(h.db, f.otherId, { ipHash: "synthetic", userAgent: "test" }))
    .token;
  const id = JSON.parse(data).connection.id;
  expect(
    (
      await removedRoute.DELETE(request(`/api/plaid/connections/${id}`, "DELETE", foreignToken), {
        params: Promise.resolve({ id }),
      })
    ).status,
  ).toBe(404);
  vi.stubEnv("PLAID_ENABLED", "false");
  expect((await listed.GET(request("/api/plaid/connections", "GET", token))).status).toBe(404);
  expect(
    (await links.POST(request("/api/plaid/link-token", "POST", null, { product: "transactions" }))).status,
  ).toBe(401);
});

it("pending becomes one posted row on a later sync, while disabled/mapping replay remains idempotent", async () => {
  const id = await connect();
  client.page = () => page([bankTransaction("pending-1", { pending: true })]);
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  expect(await rows()).toHaveLength(0);
  client.page = () =>
    page([bankTransaction("posted-1", { pendingTransactionId: "pending-1" })], {
      nextCursor: "posted-cursor",
    });
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  const mapped = await h.db
    .select()
    .from(bankConnectionAccounts)
    .where(eq(bankConnectionAccounts.connectionId, id));
  const values = mapped.map((row) => ({
    id: row.id,
    accountId: row.accountId,
    securityAccountId: row.securityAccountId,
    isEnabled: false,
  }));
  await saveMapping(h.db, f.ownerId, id, config, { importFromDate: "2026-10-01", accounts: values }, now);
  await saveMapping(
    h.db,
    f.ownerId,
    id,
    config,
    { importFromDate: "2026-10-01", accounts: values.map((row) => ({ ...row, isEnabled: true })) },
    now,
  );
  expect((await requireConnection(h.db, f.ownerId, id)).transactionsCursor).toBeNull();
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  expect(await rows()).toHaveLength(1);
});
it("keeps missing-FX observations draft and records consent expiry", async () => {
  client.accountRows = [{ ...bankAccount(), currency: "CNY" }];
  client.item.consentExpiresAt = "2026-10-26T00:00:00Z";
  const id = await connect(client, f.ownerId, false);
  const [mapped] = await h.db
    .select()
    .from(bankConnectionAccounts)
    .where(eq(bankConnectionAccounts.connectionId, id));
  await saveMapping(
    h.db,
    f.ownerId,
    id,
    config,
    { importFromDate: "2026-10-01", accounts: [{ id: mapped.id, accountId: f.wallet.id, isEnabled: true }] },
    now,
  );
  const result = await syncConnection(h.db, f.ownerId, id, client, config, now);
  expect(result).toMatchObject({ missingFx: true });
  expect((await h.db.select().from(balanceSnapshots))[0].status).toBe("draft");
  expect((await requireConnection(h.db, f.ownerId, id)).status).toBe("consent_expiring");
});
it("rejects foreign/wrong-currency mappings and duplicate ledger mappings", async () => {
  const id = await connect(client, f.ownerId, false);
  const [mapped] = await h.db
    .select()
    .from(bankConnectionAccounts)
    .where(eq(bankConnectionAccounts.connectionId, id));
  const foreign = await createAccount(h.db, f.otherId, {
    name: "Other checking",
    type: "asset_cash",
    currency: "USD",
  });
  for (const accountId of [foreign.id, f.wallet.id, f.card.id])
    await expect(
      saveMapping(
        h.db,
        f.ownerId,
        id,
        config,
        { importFromDate: "2026-10-01", accounts: [{ id: mapped.id, accountId, isEnabled: true }] },
        now,
      ),
    ).rejects.toThrow();
  await saveMapping(
    h.db,
    f.ownerId,
    id,
    config,
    { importFromDate: "2026-10-01", accounts: [{ id: mapped.id, accountId: f.bank.id, isEnabled: true }] },
    now,
  );
  const otherClient = new FakePlaid();
  otherClient.item.id = "second-item";
  const otherId = await connect(otherClient, f.ownerId, false);
  const [other] = await h.db
    .select()
    .from(bankConnectionAccounts)
    .where(eq(bankConnectionAccounts.connectionId, otherId));
  await expect(
    saveMapping(
      h.db,
      f.ownerId,
      otherId,
      config,
      { importFromDate: "2026-10-01", accounts: [{ id: other.id, accountId: f.bank.id, isEnabled: true }] },
      now,
    ),
  ).rejects.toThrow("已映射");
});
it("does not claim Plaid while disabled and ignores a stale worker lease", async () => {
  const id = await connect();
  expect(await claimJob(h.db, "disabled-worker", now)).toBeNull();
  const [a, b] = await Promise.all([
    claimJob(h.db, "worker-a", now, true),
    claimJob(h.db, "worker-b", now, true),
  ]);
  const claimed = (a ?? b)!;
  expect([a, b].filter(Boolean)).toHaveLength(1);
  client.page = () => page([bankTransaction("stale-worker-row")]);
  await h.db
    .update(importJobs)
    .set({ lockedBy: "replacement-worker", attempts: claimed.attempts + 1 })
    .where(eq(importJobs.id, claimed.id));
  await expect(syncConnection(h.db, f.ownerId, id, client, config, now, claimed)).rejects.toMatchObject({
    status: 409,
  });
  expect(await rows()).toHaveLength(0);
  expect((await requireConnection(h.db, f.ownerId, id)).transactionsCursor).toBeNull();
});
it("approved upstream changes outside the original import window are still flagged", async () => {
  const id = await connect();
  client.page = () => page([bankTransaction("approved")]);
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  const [row] = await rows();
  await approve(row);
  client.page = () =>
    page([], {
      modified: [bankTransaction("approved", { date: "2026-09-30", currency: null })],
      nextCursor: "changed",
    });
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  expect((await rows())[0].upstreamState).toBe("modified");
});
it("pagination does not expose any partial data when an empty cursor indicates not ready", async () => {
  client.page = (cursor) =>
    cursor
      ? page([], { nextCursor: "", updateStatus: "NOT_READY" })
      : page([bankTransaction("temporary")], { nextCursor: "partial", hasMore: true });
  expect(await collectSync(client, client.accessToken, "committed")).toBeNull();
});

it("merges same-day connections into one observation and versions only updated account items", async () => {
  client.accountRows = [bankAccount("bank")];
  const bankId = await connect();
  await syncConnection(h.db, f.ownerId, bankId, client, config, now);
  const [original] = await h.db.select().from(snapshotItems);
  const cardClient = new FakePlaid();
  cardClient.item.id = "second-card-item";
  cardClient.accountRows = [bankAccount("card", "credit", "77.0000")];
  const cardId = await connect(cardClient);
  await syncConnection(h.db, f.ownerId, cardId, cardClient, config, new Date(now.getTime() + 60000));
  expect(await h.db.select().from(balanceSnapshots)).toHaveLength(1);
  const merged = await h.db.select().from(snapshotItems);
  expect(merged.find((row) => row.id === original.id)!.isCurrent).toBe(true);
  expect(merged.find((row) => row.accountId === f.card.id)!.balanceNative).toBe("-77.0000");
  expect(merged.find((row) => row.accountId === f.card.id)!.sourceRef).toContain(cardId);
  client.accountRows[0].current = "950.0000";
  await syncConnection(h.db, f.ownerId, bankId, client, config, new Date(now.getTime() + 120000));
  const history = await h.db.select().from(snapshotItems);
  expect(history.filter((row) => row.accountId === f.card.id)).toHaveLength(1);
  expect(history.filter((row) => row.accountId === f.bank.id)).toHaveLength(2);
});
it("creates an unpublished carried-forward draft from partial Plaid observations without creating entries", async () => {
  const { createSnapshot, publishSnapshot, updateSnapshot } = await import("@/lib/snapshots/service");
  const { createLatestSyncDraft, latestSyncedBalances } = await import("@/lib/bank-sync/observations");
  const baseline = await createSnapshot(h.db, f.ownerId, {
    snapshotDate: "2026-10-01",
    label: "Synthetic complete baseline",
    items: [
      { accountId: f.bank.id, balanceNative: "900", currency: "USD" },
      { accountId: f.card.id, balanceNative: "-100", currency: "USD" },
      { accountId: f.prepaid.id, balanceNative: "75", currency: "USD" },
    ],
    fx: [],
  });
  await publishSnapshot(h.db, f.ownerId, baseline.id);
  const id = await connect();
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  expect(await latestSyncedBalances(h.db, f.ownerId)).toHaveLength(2);
  const draft = await createLatestSyncDraft(h.db, f.ownerId, now);
  expect(draft).toMatchObject({ status: "draft", source: "manual" });
  expect(draft.items.find((item) => item.accountId === f.bank.id)!.balanceNative).toBe("1000.0000");
  expect(draft.items.find((item) => item.accountId === f.prepaid.id)).toMatchObject({
    balanceNative: "75.0000",
    notes: "沿用 2026-10-01 观察值，待确认",
  });
  expect(draft.notes).toContain("缺少观察");
  expect(await h.db.select().from(journalEntries)).toHaveLength(0);
  // Existing manual completion flow: filling all real accounts allows the owner to confirm completeness.
  const [plaid] = (await h.db.select().from(balanceSnapshots)).filter((row) => row.source === "plaid");
  const all = await h.db.select().from(accounts).where(eq(accounts.ownerId, f.ownerId));
  await updateSnapshot(h.db, f.ownerId, plaid.id, {
    expectedRevision: plaid.revision,
    items: all
      .filter((row) => row.isActive && !row.isSystem && row.currency === "USD")
      .map((row) => ({ accountId: row.id, currency: "USD", balanceNative: "0" })),
  });
  // CNY is still uncovered: completeness is never assumed from only mapped accounts.
  expect(
    (await h.db.select().from(balanceSnapshots).where(eq(balanceSnapshots.id, plaid.id)))[0].isComplete,
  ).toBe(false);
});
it("appends a new frozen currency without changing an existing published observation; missing FX waits for later sync", async () => {
  const { saveFxRate } = await import("@/lib/snapshots/fx");
  const { getSnapshot } = await import("@/lib/snapshots/service");
  client.accountRows = [bankAccount("bank")];
  const bankId = await connect();
  await syncConnection(h.db, f.ownerId, bankId, client, config, now);
  const [daily] = await h.db.select().from(balanceSnapshots);
  const foreignClient = new FakePlaid();
  foreignClient.item.id = "foreign-currency-item";
  foreignClient.accountRows = [{ ...bankAccount("cny"), currency: "CNY" }];
  const foreignId = await connect(foreignClient, f.ownerId, false);
  const [mapped] = await h.db
    .select()
    .from(bankConnectionAccounts)
    .where(eq(bankConnectionAccounts.connectionId, foreignId));
  await saveMapping(
    h.db,
    f.ownerId,
    foreignId,
    config,
    { importFromDate: "2026-10-01", accounts: [{ id: mapped.id, accountId: f.wallet.id, isEnabled: true }] },
    now,
  );
  await syncConnection(h.db, f.ownerId, foreignId, foreignClient, config, now);
  expect((await getSnapshot(h.db, f.ownerId, daily.id)).status).toBe("published");
  expect((await getSnapshot(h.db, f.ownerId, daily.id)).items).toHaveLength(1);
  expect((await requireConnection(h.db, f.ownerId, foreignId)).errorCode).toBe("MISSING_FX_CNY");
  await saveFxRate(h.db, f.ownerId, {
    baseCurrency: "USD",
    quoteCurrency: "CNY",
    rate: "6.8",
    observedOn: "2026-10-23",
    source: "synthetic",
    isManual: true,
  });
  await syncConnection(h.db, f.ownerId, foreignId, foreignClient, config, new Date(now.getTime() + 1000));
  const updated = await getSnapshot(h.db, f.ownerId, daily.id);
  expect(updated.items).toHaveLength(2);
  expect(updated.fx[0].rate).toBe("6.8000000000");
  const frozenId = updated.fx[0].id;
  await saveFxRate(h.db, f.ownerId, {
    baseCurrency: "USD",
    quoteCurrency: "CNY",
    rate: "7.0",
    observedOn: "2026-10-24",
    source: "synthetic",
    isManual: true,
  });
  await syncConnection(h.db, f.ownerId, foreignId, foreignClient, config, new Date(now.getTime() + 2000));
  expect((await getSnapshot(h.db, f.ownerId, daily.id)).fx[0]).toMatchObject({
    id: frozenId,
    rate: "6.8000000000",
  });
});

it("CSP keeps the nonce/strict-dynamic and exact Plaid hosts for saved settings", async () => {
  const { proxy } = await import("@/proxy");
  const sandbox = proxy(new NextRequest("http://localhost:3000/api/health")).headers.get(
    "Content-Security-Policy",
  )!;
  expect(sandbox).toContain("'nonce-");
  expect(sandbox).toContain("'strict-dynamic'");
  expect(sandbox).toContain("https://cdn.plaid.com/link/v2/stable/link-initialize.js");
  expect(sandbox).toContain("frame-src https://cdn.plaid.com/");
  expect(sandbox).toContain("https://sandbox.plaid.com");
  vi.stubEnv("PLAID_ENABLED", "false");
  expect(
    proxy(new NextRequest("http://localhost:3000/api/health")).headers.get("Content-Security-Policy"),
  ).toContain("connect-src 'self' https://production.plaid.com https://sandbox.plaid.com");
});
