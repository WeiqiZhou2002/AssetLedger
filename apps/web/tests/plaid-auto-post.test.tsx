import { entryMatching, resolveEntryMatching } from "@/lib/bank-sync/matching";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { FakePlaid, bankAccount, bankTransaction, plaidConfig as config } from "./helpers/plaid";
import type { BankTransaction, SyncPage } from "@/lib/bank-sync/types";
import { auditLogs, categories, importRows, journalEntries, statements } from "@/db/schema";
import { exchangeConnection, saveMapping, requireConnection } from "@/lib/bank-sync/connections";
import { syncConnection } from "@/lib/bank-sync/sync";
import { pendingCount, pendingWorkbench, resolvePending, setAutoPost } from "@/lib/bank-sync/pending";
import { getEntry, createEntry, updateEntryMeta, voidEntry } from "@/lib/ledger/entries";
import { buildPostings } from "@/lib/ledger/builders";
import { createAccount, listAccounts } from "@/lib/ledger/accounts";
import { accountBalance, spendingSummary } from "@/lib/ledger/queries";
import { createSession } from "@/lib/auth/session";
import { jsonSafe } from "@/lib/serialization";
import { PendingView } from "@/components/bank-sync/pending-view";
import { AppNavigation } from "@/components/app-navigation";
import { isTransferLike } from "@/lib/bank-sync/transfer-config";
import { autoEntryInput, autoPostOwnerRows } from "@/lib/bank-sync/auto-post";
import { stampAutoEntry } from "@/lib/bank-sync/auto-state";
import { clearingInput } from "@/lib/bank-sync/transfer-legs";
import { CORE_SWEEP_NOTE } from "@/lib/bank-sync/core-sweeps";
import { importLock } from "@/lib/imports/store";
let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
const now = new Date("2026-10-24T12:00:00Z");
vi.mock("@/db/client", () => ({ getDb: () => h.db }));
vi.mock("@/lib/auth/current-user", () => ({
  requireUser: async () => ({ id: f.ownerId, timezone: "America/Los_Angeles", baseCurrency: "USD" }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/statements",
  useSearchParams: () => new URLSearchParams("tab=sync"),
}));
const pendingRoute = await import("@/app/api/plaid/pending/route");
const settingRoute = await import("@/app/api/plaid/connections/[id]/auto-post/route");
const hub = await import("@/app/(app)/statements/page");
const dashboard = await import("@/app/(app)/dashboard/page");
const accountPage = await import("@/app/(app)/accounts/page");
beforeAll(async () => {
  h = await createTestDb();
  for (const [key, value] of Object.entries(config)) vi.stubEnv(key, String(value));
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic/test");
});
afterAll(async () => {
  await h.client.close();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
  vi.stubEnv("PLAID_ENABLED", "true");
});
async function connect(id: string, type: string, accountId: string, autoPost = true) {
  const client = new FakePlaid();
  client.item.id = `item-${id}`;
  client.accountRows = [bankAccount(id, type)];
  const linked = await exchangeConnection(
    h.db,
    f.ownerId,
    client,
    config,
    {
      public_token: "synthetic-public",
      institution: { institution_id: "ins_synthetic", name: "Example Bank" },
    },
    now,
  );
  expect(linked.connection.autoPost).toBe(true);
  await saveMapping(
    h.db,
    f.ownerId,
    linked.connection.id,
    config,
    {
      importFromDate: "2026-10-01",
      accounts: [{ id: linked.accounts[0].id, accountId }],
    },
    now,
  );
  if (!autoPost) await setAutoPost(h.db, f.ownerId, linked.connection.id, config, { autoPost });
  return { id: linked.connection.id, client, plaidAccountId: id };
}
type Connection = Awaited<ReturnType<typeof connect>>;
const tx = (connection: Connection, id: string, changes: Partial<BankTransaction> = {}) =>
  bankTransaction(id, { accountId: connection.plaidAccountId, ...changes });
async function sync(connection: Connection, added: BankTransaction[] = [], rest: Partial<SyncPage> = {}) {
  connection.client.page = () => ({
    accounts: connection.client.accountRows,
    added,
    modified: [],
    removed: [],
    hasMore: false,
    nextCursor: `cursor-${connection.client.cursors.length}`,
    updateStatus: "HISTORICAL_UPDATE_COMPLETE",
    ...rest,
  });
  return syncConnection(h.db, f.ownerId, connection.id, connection.client, config, now);
}
const confirmed = () =>
  h.db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.ownerId, f.ownerId), eq(journalEntries.status, "confirmed")));
const rows = () => h.db.select().from(importRows).where(eq(importRows.ownerId, f.ownerId));
const workbench = () => pendingWorkbench(h.db, f.ownerId, "sandbox");
async function ownerClearing(amount: string, description: string) {
  return createEntry(h.db, f.ownerId, {
    ...(await clearingInput(h.db, f.ownerId, {
      accountId: f.bank.id,
      amount,
      currency: "USD",
      transactionDate: "2026-10-22",
      postedDate: "2026-10-22",
      merchantNormalized: description,
      descriptionRaw: description,
    })),
    source: "manual",
    externalReference: "transfer:manual",
  });
}
async function noSpendingOrIncome() {
  expect(await accountBalance(h.db, f.ownerId, f.expense.id, "2026-10-31")).toBe("0.0000");
  expect(await accountBalance(h.db, f.ownerId, f.income.id, "2026-10-31")).toBe("0.0000");
  expect(
    await spendingSummary(h.db, f.ownerId, {
      from: "2026-10-01",
      to: "2026-10-31",
      basis: "posted",
      groupBy: "category",
    }),
  ).toEqual([]);
}

it("auto-posts classified confirmed rows, keeps signs/categories, skips pending and out-of-range, and never repeats provider IDs", async () => {
  const bank = await connect("bank", "depository", f.bank.id);
  const card = await connect("card", "credit", f.card.id);
  const added = [
    tx(bank, "cafe"),
    tx(bank, "payroll", {
      amount: "-500",
      name: "Sweetgreen inc payroll ppd id",
      merchantName: "Sweetgreen",
    }),
    tx(bank, "fee", { amount: "3", primary: "BANK_FEES", name: "Bank fee" }),
    tx(bank, "old", { date: "2026-09-30" }),
    tx(bank, "pending", { pending: true }),
  ];
  await sync(bank, added);
  await sync(card, [
    tx(card, "charge", { amount: "40" }),
    tx(card, "refund", { amount: "-5", name: "MERCHANT REFUND" }),
  ]);
  expect(await confirmed()).toHaveLength(5);
  expect((await rows()).every((row) => row.journalEntryId && row.autoPostState === "posted")).toBe(true);
  expect(await accountBalance(h.db, f.ownerId, f.bank.id, "2026-10-31")).toBe("477.0000");
  expect(await accountBalance(h.db, f.ownerId, f.card.id, "2026-10-31")).toBe("-35.0000");
  const payroll = (await rows()).find((row) => row.providerTransactionId === "payroll")!;
  expect(
    (await getEntry(h.db, f.ownerId, payroll.journalEntryId!)).postings.some(
      (line) => line.categoryId === f.category("工资"),
    ),
  ).toBe(true);
  await sync(bank, added);
  expect(await confirmed()).toHaveLength(5);
});
it("voids an untouched posted row modified upstream into a SPAXX sweep without replacement", async () => {
  const bank = await connect("bank", "depository", f.bank.id);
  const original = tx(bank, "modified", {
    originalDescription: "Synthetic activity",
    merchantName: "Example Brokerage",
  });
  await sync(bank, [original]);
  const [entry] = await confirmed();
  await sync(bank, [], { modified: [{ ...original, name: "REDEMPTION FROM CORE ACCOUNT (SPAXX)" }] });
  expect(await getEntry(h.db, f.ownerId, entry.id)).toMatchObject({ status: "voided" });
  expect((await rows())[0]).toMatchObject({
    decision: "exclude",
    autoPostState: "resolved",
    upstreamState: "none",
    journalEntryId: entry.id,
  });
  expect(await h.db.select().from(journalEntries)).toHaveLength(1);
  expect(await pendingCount(h.db, f.ownerId, "sandbox")).toBe(0);
  await sync(bank);
  expect((await h.db.select().from(auditLogs)).filter((row) => row.action === "entry.void")).toHaveLength(1);
});
it("cleans legacy SPAXX postings and unposted rows before matching, preserves owner edits and matches, and is idempotent", async () => {
  const bank = await connect("bank", "depository", f.bank.id, false);
  const ids = ["plain", "clearing", "edited", "matched", "pending", "duplicate"];
  await sync(
    bank,
    ids.map((id) => tx(bank, id)),
  );
  const entries = new Map<string, string>();
  for (const row of await rows()) {
    const kind = row.providerTransactionId!;
    const [legacy] = await h.db
      .update(importRows)
      .set({
        descriptionRaw: "REDEMPTION FROM CORE ACCOUNT (SPAXX)",
        merchantNormalized: "EXAMPLE BROKERAGE",
        softNotes: ["旧行提示"],
      })
      .where(eq(importRows.id, row.id))
      .returning();
    if (kind === "pending") continue;
    if (kind === "duplicate") {
      await h.db
        .update(importRows)
        .set({
          autoPostState: "duplicate",
          duplicateCandidateRowIds: [crypto.randomUUID()],
          duplicateCandidateEntryIds: [crypto.randomUUID()],
        })
        .where(eq(importRows.id, row.id));
      continue;
    }
    const entry = await createEntry(
      h.db,
      f.ownerId,
      kind === "clearing" || kind === "matched"
        ? await clearingInput(h.db, f.ownerId, legacy)
        : await buildPostings(h.db, f.ownerId, "expense", {
            amount: "20",
            fromAccountId: f.bank.id,
            categoryId: f.category("其他支出"),
            eventDate: "2026-10-21",
            description: legacy.descriptionRaw,
          }),
    );
    if (kind === "matched")
      await h.db
        .update(journalEntries)
        .set({ transferMatchId: crypto.randomUUID() })
        .where(eq(journalEntries.id, entry.id));
    await stampAutoEntry(h.db, f.ownerId, entry.id);
    if (kind === "edited")
      await updateEntryMeta(h.db, f.ownerId, entry.id, { notes: "Owner retained this entry" });
    await h.db
      .update(importRows)
      .set({ journalEntryId: entry.id, autoPostState: "posted", decision: "approve" })
      .where(eq(importRows.id, row.id));
    entries.set(kind, entry.id);
  }
  await setAutoPost(h.db, f.ownerId, bank.id, config, { autoPost: true });
  const cleanup = () =>
    h.db.transaction(async (db) => {
      await importLock(db, f.ownerId);
      await autoPostOwnerRows(db, f.ownerId, "sandbox", now);
    });
  await cleanup();
  for (const kind of ["plain", "clearing"]) {
    expect(await getEntry(h.db, f.ownerId, entries.get(kind)!)).toMatchObject({ status: "voided" });
    expect((await rows()).find((row) => row.providerTransactionId === kind)).toMatchObject({
      autoPostState: "resolved",
      decision: "exclude",
      softNotes: ["旧行提示", CORE_SWEEP_NOTE],
    });
  }
  for (const kind of ["edited", "matched"]) {
    expect(await getEntry(h.db, f.ownerId, entries.get(kind)!)).toMatchObject({ status: "confirmed" });
    expect((await rows()).find((row) => row.providerTransactionId === kind)).toMatchObject({
      autoPostState: "posted",
      decision: "approve",
      softNotes: ["旧行提示"],
    });
  }
  const pending = (await rows()).find((row) => row.providerTransactionId === "pending")!;
  expect(pending).toMatchObject({
    journalEntryId: null,
    decision: "exclude",
    softNotes: ["旧行提示", CORE_SWEEP_NOTE],
  });
  expect(pending.reviewedAt).not.toBeNull();
  expect((await rows()).find((row) => row.providerTransactionId === "duplicate")).toMatchObject({
    decision: "exclude",
    autoPostState: "resolved",
    duplicateCandidateRowIds: [],
    duplicateCandidateEntryIds: [],
  });
  expect(await pendingCount(h.db, f.ownerId, "sandbox")).toBe(0);
  expect((await h.db.select().from(statements))[0].status).toBe("approved");
  const audit = await h.db.select().from(auditLogs);
  expect(audit.filter((row) => row.action === "entry.void")).toHaveLength(2);
  const ignored = audit.filter((row) => row.action === "bank.core_sweep_ignored");
  expect(ignored).toHaveLength(2);
  expect(ignored.every((row) => Object.keys(row.changes).sort().join() === "entryId,rowId")).toBe(true);
  const before = await rows();
  await cleanup();
  expect(await rows()).toEqual(before);
  expect(await h.db.select().from(auditLogs)).toHaveLength(audit.length);
  expect(await h.db.select().from(journalEntries)).toHaveLength(4);
});
it("ignores old undecided payment suggestions and decision payloads when auto-posting without a bank leg", async () => {
  const bank = await connect("bank", "depository", f.bank.id);
  const card = await connect("card", "credit", f.card.id, false);
  await sync(bank);
  await sync(card, [tx(card, "old-payment", { amount: "-283.58", name: "PAYMENT THANK YOU MOBILE" })]);
  const [row] = await rows();
  const [oldRow] = await h.db
    .update(importRows)
    .set({
      suggestedCounterAccountId: f.bank.id,
      suggestedEntryType: "credit_card_payment",
      decisionPayload: { pairRowId: crypto.randomUUID(), pairEntryId: crypto.randomUUID() },
      reviewedAt: now,
    })
    .where(and(eq(importRows.ownerId, f.ownerId), eq(importRows.id, row.id)))
    .returning();
  const input = await autoEntryInput(h.db, f.ownerId, oldRow);
  expect(input.postings.some((line) => line.accountId === f.bank.id)).toBe(false);
  await setAutoPost(h.db, f.ownerId, card.id, config, { autoPost: true });
  await sync(card);
  const [posted] = await rows();
  const entry = await getEntry(h.db, f.ownerId, posted.journalEntryId!);
  expect(entry).toMatchObject({ status: "confirmed", autoPosted: true, transferMatchId: null });
  expect(entry.postings).toHaveLength(2);
  expect(entry.entryType).toBe("income");
  expect(entry.postings.map((line) => [line.accountId, line.amount])).toEqual(
    expect.arrayContaining([
      [f.card.id, "283.5800"],
      [f.income.id, "-283.5800"],
    ]),
  );
  expect(await accountBalance(h.db, f.ownerId, f.bank.id, "2026-10-31")).toBe("0.0000");
  expect((await workbench()).transfers).toHaveLength(0);
  expect(await accountBalance(h.db, f.ownerId, f.income.id, "2026-10-31")).toBe("-283.5800");
  await sync(card);
  expect((await confirmed()).map((entry) => entry.id)).toEqual([entry.id]);
});
it("matches cross-connection card payments five days apart without moving either posting date or counting income/spending", async () => {
  const bank = await connect("bank", "depository", f.bank.id);
  const card = await connect("card", "credit", f.card.id);
  await sync(bank, [
    tx(bank, "bank-pay", {
      amount: "100",
      date: "2026-10-19",
      name: "ONLINE PAYMENT",
      primary: "LOAN_PAYMENTS",
    }),
  ]);
  const original = (await confirmed())[0];
  expect((await workbench()).transfers).toHaveLength(0);
  expect(await accountBalance(h.db, f.ownerId, f.expense.id, "2026-10-31")).toBe("100.0000");
  await sync(card, [tx(card, "card-pay", { amount: "-100", date: "2026-10-24", name: "PAYMENT THANK YOU" })]);
  const entries = await confirmed();
  expect(entries).toHaveLength(2);
  expect(entries.map((entry) => entry.postedDate).sort()).toEqual(["2026-10-19", "2026-10-24"]);
  expect(entries.every((entry) => entry.entryType === "credit_card_payment")).toBe(true);
  expect(new Set(entries.map((entry) => entry.transferMatchId)).size).toBe(1);
  expect(entries[0].transferMatchId).toBeTruthy();
  expect(entries.some((entry) => entry.replacesEntryId === original.id)).toBe(true);
  expect((await workbench()).count).toBe(0);
  expect(await accountBalance(h.db, f.ownerId, f.card.id, "2026-10-20")).toBe("0.0000");
  expect(await accountBalance(h.db, f.ownerId, f.bank.id, "2026-10-20")).toBe("-100.0000");
  await noSpendingOrIncome();
  expect((await h.db.select().from(auditLogs)).filter((row) => row.action === "auto_matched")).toHaveLength(
    2,
  );
});

it("keeps debit/credit signs authoritative when PFC says income and recognizes charged interest", async () => {
  const bank = await connect("bank", "depository", f.bank.id);
  const card = await connect("card", "credit", f.card.id);
  await sync(bank, [tx(bank, "debit", { amount: "20", primary: "INCOME" })]);
  await sync(card, [
    tx(card, "credit", { amount: "-10", primary: "INCOME", name: "Merchant refund" }),
    tx(card, "interest", {
      amount: "5",
      primary: "BANK_FEES",
      detailed: "BANK_FEES_INTEREST",
      name: "Interest charged",
    }),
  ]);
  const entries = await confirmed();
  expect(entries.map((row) => row.entryType).sort()).toEqual(["expense", "interest", "refund"]);
  expect(await accountBalance(h.db, f.ownerId, f.income.id, "2026-10-31")).toBe("0.0000");
});
it("matches Zelle between owned checking accounts and posts unmatched Venmo/card payments as expense/income", async () => {
  const bank = await connect("bank", "depository", f.bank.id);
  const secondBank = await createAccount(h.db, f.ownerId, {
    name: "Example savings",
    type: "asset_cash",
    currency: "USD",
  });
  const broker = await connect("broker", "depository", secondBank.id);
  const card = await connect("card", "credit", f.card.id);
  await sync(bank, [
    tx(bank, "zelle-out", { amount: "100", name: "Zelle to own account" }),
    tx(bank, "friend", { amount: "30", name: "Venmo to Alex Sample" }),
  ]);
  await sync(broker, [tx(broker, "zelle-in", { amount: "-100", name: "Zelle received" })]);
  await sync(card, [tx(card, "payment", { amount: "-50", name: "PAYMENT RECEIVED", primary: null })]);
  expect((await confirmed()).filter((row) => row.transferMatchId)).toHaveLength(2);
  expect((await workbench()).transfers).toHaveLength(0);
  expect(await pendingCount(h.db, f.ownerId, "sandbox")).toBe(0);
  expect(await accountBalance(h.db, f.ownerId, f.expense.id, "2026-10-31")).toBe("30.0000");
  expect(await accountBalance(h.db, f.ownerId, f.income.id, "2026-10-31")).toBe("-50.0000");
});
it("does not guess when two equal counterpart candidates exist, and supports explicit matching", async () => {
  const bank = await connect("bank", "depository", f.bank.id, false);
  const secondBank = await createAccount(h.db, f.ownerId, {
    name: "Example savings",
    type: "asset_cash",
    currency: "USD",
  });
  const broker = await connect("broker", "depository", secondBank.id, false);
  const other = await createAccount(h.db, f.ownerId, {
    name: "Example second bank",
    type: "asset_cash",
    currency: "USD",
  });
  const bank2 = await connect("bank2", "depository", other.id, false);
  await sync(bank, [tx(bank, "out", { amount: "100", name: "Venmo transfer" })]);
  await sync(broker, [tx(broker, "in1", { amount: "-100", name: "Venmo transfer" })]);
  await sync(bank2, [tx(bank2, "in2", { amount: "-100", name: "Venmo transfer" })]);
  expect(await confirmed()).toHaveLength(0);
  for (const connection of [bank, broker, bank2])
    await setAutoPost(h.db, f.ownerId, connection.id, config, { autoPost: true });
  await sync(bank);
  const pending = await workbench();
  expect(pending.transfers).toHaveLength(0);
  expect(pending.suggestions).toHaveLength(2);
  const outgoingId = (await rows()).find((row) => row.accountId === f.bank.id)!.journalEntryId!;
  const outgoing = await entryMatching(h.db, f.ownerId, outgoingId);
  expect(outgoing.candidates).toHaveLength(2);
  await resolveEntryMatching(h.db, f.ownerId, outgoingId, {
    action: "match",
    counterpartEntryId: outgoing.candidates[0].id,
  });
  expect((await workbench()).transfers).toHaveLength(0);
  expect(await accountBalance(h.db, f.ownerId, f.expense.id, "2026-10-31")).toBe("0.0000");
  expect(await accountBalance(h.db, f.ownerId, f.income.id, "2026-10-31")).toBe("-100.0000");
});
it("assigns an unconnected card, and categorizes a friend transfer via void/replacement with owner isolation", async () => {
  await ownerClearing("-100", "EPAY");
  await ownerClearing("-30", "Venmo Alex Sample");
  const pending = await workbench();
  const assigned = pending.transfers.find((row) => row.amount === "-100.0000")!;
  await expect(
    resolvePending(h.db, f.otherId, config, { action: "assign", entryId: assigned.id, accountId: f.card.id }),
  ).rejects.toThrow("不存在");
  await resolvePending(h.db, f.ownerId, config, {
    action: "assign",
    entryId: assigned.id,
    accountId: f.card.id,
  });
  expect(await accountBalance(h.db, f.ownerId, f.card.id, "2026-10-31")).toBe("100.0000");
  const friend = (await workbench()).transfers[0];
  const result = await resolvePending(h.db, f.ownerId, config, {
    action: "categorize",
    entryId: friend.id,
    type: "expense",
    categoryId: f.category("餐饮"),
  });
  expect(result).toHaveProperty("entryId");
  expect((await getEntry(h.db, f.ownerId, friend.id)).status).toBe("voided");
  expect((await confirmed()).find((row) => row.replacesEntryId === friend.id)?.autoPostOwnerEdited).toBe(
    true,
  );
  expect(await accountBalance(h.db, f.ownerId, f.expense.id, "2026-10-31")).toBe("30.0000");
  expect((await workbench()).count).toBe(0);
});
it.each(["income", "refund", "loan_out", "loan_repayment"] as const)(
  "supports classify-as %s with correct signs and receivable rules",
  async (type) => {
    const positive = type !== "loan_out";
    await ownerClearing(positive ? "35" : "-35", "Venmo Alex Sample");
    const [leg] = (await workbench()).transfers;
    await resolvePending(h.db, f.ownerId, config, {
      action: "categorize",
      entryId: leg.id,
      type,
      ...(type.startsWith("loan_")
        ? { accountId: f.receivable.id }
        : { categoryId: f.category(type === "income" ? "其他收入" : "餐饮") }),
    });
    expect((await confirmed())[0].entryType).toBe(type);
    expect(await accountBalance(h.db, f.ownerId, f.bank.id, "2026-10-31")).toBe(
      positive ? "35.0000" : "-35.0000",
    );
  },
);
it("links a suspected PDF duplicate as evidence until keep-existing or post-distinct is chosen", async () => {
  const input = await buildPostings(h.db, f.ownerId, "expense", {
    amount: "20",
    fromAccountId: f.bank.id,
    categoryId: f.category("餐饮"),
    eventDate: "2026-10-22",
    merchant: "example cafe",
  });
  const prior = await createEntry(h.db, f.ownerId, { ...input, source: "import" });
  const [statement] = await h.db
    .insert(statements)
    .values({
      ownerId: f.ownerId,
      accountId: f.bank.id,
      originalFilename: "Synthetic.pdf",
      mime: "application/pdf",
      sizeBytes: 10,
      fileSha256: "synthetic-pdf",
      status: "approved",
    })
    .returning();
  await h.db.insert(importRows).values({
    ownerId: f.ownerId,
    statementId: statement.id,
    rowIndex: 0,
    sourceRowText: "Example Cafe",
    descriptionRaw: "Example Cafe",
    merchantNormalized: "example cafe",
    amountRaw: "-20",
    amount: "-20",
    currency: "USD",
    direction: "charge",
    confidence: "1",
    rowSignature: "synthetic",
    journalEntryId: prior.id,
  });
  const bank = await connect("bank", "depository", f.bank.id);
  await sync(bank, [tx(bank, "duplicate")]);
  expect(await confirmed()).toHaveLength(1);
  const candidate = (await workbench()).rows[0].row;
  expect(candidate.linkedEntryId).toBe(prior.id);
  await resolvePending(h.db, f.ownerId, config, { action: "keep_existing", rowId: candidate.id });
  expect((await workbench()).count).toBe(0);
  await sync(bank, [tx(bank, "distinct")]);
  const second = (await workbench()).rows[0].row;
  await resolvePending(h.db, f.ownerId, config, { action: "post_distinct", rowId: second.id });
  await resolvePending(h.db, f.ownerId, config, { action: "post_distinct", rowId: second.id });
  expect(await confirmed()).toHaveLength(2);
});
it("automatically replaces/removes untouched entries, flags owner edits, and supports both upstream decisions", async () => {
  const bank = await connect("bank", "depository", f.bank.id);
  await sync(bank, [tx(bank, "expense")]);
  const old = (await confirmed())[0];
  await sync(bank, [], { modified: [tx(bank, "expense", { amount: "25" })] });
  const updated = (await confirmed())[0];
  expect(updated.replacesEntryId).toBe(old.id);
  expect(await accountBalance(h.db, f.ownerId, f.bank.id, "2026-10-31")).toBe("-25.0000");
  await updateEntryMeta(h.db, f.ownerId, updated.id, { notes: "Owner reviewed" });
  await sync(bank, [], { modified: [tx(bank, "expense", { amount: "30" })] });
  expect(await accountBalance(h.db, f.ownerId, f.bank.id, "2026-10-31")).toBe("-25.0000");
  const flagged = (await workbench()).rows[0].row;
  await resolvePending(h.db, f.ownerId, config, { action: "keep_local", rowId: flagged.id });
  expect((await workbench()).count).toBe(0);
  await sync(bank, [], { modified: [tx(bank, "expense", { amount: "35" })] });
  await resolvePending(h.db, f.ownerId, config, { action: "apply_upstream", rowId: flagged.id });
  expect(await accountBalance(h.db, f.ownerId, f.bank.id, "2026-10-31")).toBe("-35.0000");
  await sync(bank, [], { removed: ["expense"] });
  expect((await workbench()).rows[0].row.upstreamState).toBe("removed");
  await resolvePending(h.db, f.ownerId, config, { action: "apply_upstream", rowId: flagged.id });
  expect(await confirmed()).toHaveLength(0);
  await sync(bank, [tx(bank, "untouched", { name: "Example Store", merchantName: "Example Store" })]);
  await sync(bank, [], { removed: ["untouched"] });
  expect(await confirmed()).toHaveLength(0);
});
it("unlinks a modified paired leg, preserves the other leg, and never resurrects an owner-voided entry", async () => {
  const bank = await connect("bank", "depository", f.bank.id);
  const card = await connect("card", "credit", f.card.id);
  await sync(bank, [tx(bank, "out", { amount: "100", name: "AUTOPAY" })]);
  await sync(card, [tx(card, "in", { amount: "-100", name: "PAYMENT RECEIVED" })]);
  const original = (await rows()).find((row) => row.providerTransactionId === "out")!.journalEntryId!;
  await sync(bank, [], { modified: [tx(bank, "out", { amount: "110", name: "AUTOPAY" })] });
  expect((await workbench()).transfers).toHaveLength(0);
  expect((await confirmed()).map((entry) => entry.entryType).sort()).toEqual(["expense", "income"]);
  expect((await getEntry(h.db, f.ownerId, original)).status).toBe("voided");
  const latest = (await rows()).find((row) => row.providerTransactionId === "out")!.journalEntryId!;
  await voidEntry(h.db, f.ownerId, latest, "Owner correction");
  await sync(bank, [], { modified: [tx(bank, "out", { amount: "120", name: "AUTOPAY" })] });
  expect((await getEntry(h.db, f.ownerId, latest)).status).toBe("voided");
  expect((await workbench()).rows[0].row.autoPostState).toBe("upstream");
});

it("leaves review mode intact then processes old undecided rows on the next sync", async () => {
  const bank = await connect("bank", "depository", f.bank.id, false);
  await sync(bank, [tx(bank, "old")]);
  expect((await rows())[0].journalEntryId).toBeNull();
  expect(await confirmed()).toHaveLength(0);
  await setAutoPost(h.db, f.ownerId, bank.id, config, { autoPost: true });
  await sync(bank);
  expect((await rows())[0].journalEntryId).toBeTruthy();
  expect(await confirmed()).toHaveLength(1);
});

it("does not double-post transfer-like duplicates of already imported payments", async () => {
  const prior = await createEntry(h.db, f.ownerId, {
    ...(await buildPostings(h.db, f.ownerId, "credit_card_payment", {
      amount: "100",
      fromAccountId: f.bank.id,
      toAccountId: f.card.id,
      eventDate: "2026-10-22",
      merchant: "online payment",
    })),
    source: "import",
  });
  const bank = await connect("bank", "depository", f.bank.id);
  await sync(bank, [
    tx(bank, "payment", { amount: "100", name: "ONLINE PAYMENT", merchantName: "Online Payment" }),
  ]);
  expect(await confirmed()).toHaveLength(1);
  const pending = await workbench();
  expect(pending.transfers).toHaveLength(0);
  expect(pending.rows[0].row.linkedEntryId).toBe(prior.id);
  await resolvePending(h.db, f.ownerId, config, { action: "keep_existing", rowId: pending.rows[0].row.id });
  expect(await accountBalance(h.db, f.ownerId, f.bank.id, "2026-10-31")).toBe("-100.0000");
  await noSpendingOrIncome();
});

it("keeps owner-assigned counterpart legs as duplicate evidence when that account is connected later", async () => {
  const bank = await connect("bank", "depository", f.bank.id);
  await sync(bank, [
    tx(bank, "payment", { amount: "100", name: "Online Payment", merchantName: "Online Payment" }),
  ]);
  const [leg] = await confirmed();
  await resolveEntryMatching(h.db, f.ownerId, leg.id, { action: "assign", accountId: f.card.id });
  const card = await connect("card", "credit", f.card.id);
  await sync(card, [
    tx(card, "arrives-later", { amount: "-100", name: "Online Payment", merchantName: "Online Payment" }),
  ]);
  expect(await confirmed()).toHaveLength(2);
  expect((await workbench()).rows[0].row.autoPostState).toBe("duplicate");
  expect(await accountBalance(h.db, f.ownerId, f.card.id, "2026-10-31")).toBe("100.0000");
});

it("treats repeated identical modifications/removals as no-ops and protects income recategorization", async () => {
  const bank = await connect("bank", "depository", f.bank.id);
  await sync(bank, [
    tx(bank, "salary", { amount: "-100", name: "Payroll", merchantName: "Example employer" }),
  ]);
  const changed = tx(bank, "salary", { amount: "-110", name: "Payroll", merchantName: "Example employer" });
  await sync(bank, [], { modified: [changed] });
  const current = (await confirmed())[0];
  await sync(bank, [], { modified: [changed] });
  expect((await confirmed())[0].id).toBe(current.id);
  const entry = await getEntry(h.db, f.ownerId, current.id);
  const incomeLine = entry.postings.find((row) => row.accountId === f.income.id)!;
  await updateEntryMeta(h.db, f.ownerId, current.id, {
    categories: [{ postingId: incomeLine.id, categoryId: f.category("奖金") }],
  });
  await sync(bank, [], { removed: ["salary"] });
  const row = (await workbench()).rows[0].row;
  await resolvePending(h.db, f.ownerId, config, { action: "apply_upstream", rowId: row.id });
  await sync(bank, [], { removed: ["salary"] });
  expect((await workbench()).count).toBe(0);
  expect(await confirmed()).toHaveLength(0);
});
it("rolls back auto-posted entries, rows, observations and cursor together if a batch cannot be applied", async () => {
  const bank = await connect("bank", "depository", f.bank.id);
  await expect(
    sync(bank, [tx(bank, "good"), tx(bank, "invalid", { amount: "99999999999999999" })]),
  ).rejects.toThrow();
  expect(await confirmed()).toHaveLength(0);
  expect(await rows()).toHaveLength(0);
  expect((await requireConnection(h.db, f.ownerId, bank.id)).transactionsCursor).toBeNull();
});
it("enforces authentication, origin, owner isolation and disabled-feature 404 on the new APIs", async () => {
  const bank = await connect("bank", "depository", f.bank.id);
  await sync(bank, [tx(bank, "out", { name: "Venmo" })]);
  const entryId = (await confirmed())[0].id;
  const session = await createSession(h.db, f.otherId, { ipHash: "synthetic", userAgent: "Test" });
  const request = (origin: string, cookie?: string) =>
    new NextRequest("http://localhost:3000/api/plaid/pending", {
      method: "POST",
      headers: {
        origin,
        host: "localhost:3000",
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ action: "assign", entryId, accountId: f.card.id }),
    });
  expect((await pendingRoute.POST(request("http://localhost:3000"))).status).toBe(401);
  expect(
    (await pendingRoute.POST(request("https://evil.example", `al_session=${session.token}`))).status,
  ).toBe(403);
  expect(
    (await pendingRoute.POST(request("http://localhost:3000", `al_session=${session.token}`))).status,
  ).toBe(404);
  const list = await pendingRoute.GET(
    new NextRequest("http://localhost:3000/api/plaid/pending", {
      headers: { cookie: `al_session=${session.token}` },
    }),
  );
  expect((await list.json()).count).toBe(0);
  vi.stubEnv("PLAID_ENABLED", "false");
  expect((await pendingRoute.GET(new NextRequest("http://localhost:3000/api/plaid/pending"))).status).toBe(
    404,
  );
  expect(
    (await settingRoute.POST(request("http://localhost:3000"), { params: Promise.resolve({ id: bank.id }) }))
      .status,
  ).toBe(404);
});

it("rolls back an earlier automatic transfer when a later row has no usable expense category", async () => {
  const bank = await connect("bank", "depository", f.bank.id);
  await h.db.update(categories).set({ isArchived: true }).where(eq(categories.ownerId, f.ownerId));
  await expect(
    sync(bank, [tx(bank, "transfer-first", { name: "Venmo" }), tx(bank, "expense-second")]),
  ).rejects.toThrow("其他支出");
  expect(await confirmed()).toHaveLength(0);
  expect(await rows()).toHaveLength(0);
  expect((await requireConnection(h.db, f.ownerId, bank.id)).transactionsCursor).toBeNull();
  expect((await listAccounts(h.db, f.ownerId, true)).some((row) => row.type === "transfer_clearing")).toBe(
    false,
  );
});
it("keeps sync in navigation/accounts/hub and removes it from the money-only dashboard", async () => {
  const nav = renderToStaticMarkup(<AppNavigation plaidEnabled pendingCount={3} />);
  expect(nav).toContain("导入与同步");
  expect(nav).not.toContain("银行同步");
  expect(nav).toContain("3 项待处理");
  const empty = renderToStaticMarkup(await dashboard.default({ searchParams: Promise.resolve({}) }));
  expect(empty).not.toContain("连接银行，自动导入流水");
  expect(empty).toContain("我有多少钱");
  expect(renderToStaticMarkup(await accountPage.default())).toContain("连接银行");
  const bank = await connect("bank", "depository", f.bank.id);
  await sync(bank, [tx(bank, "transfer", { name: "Online Payment" })]);
  const data = await workbench();
  const view = renderToStaticMarkup(
    <PendingView
      data={jsonSafe(data)}
      accounts={await listAccounts(h.db, f.ownerId)}
      categories={f.categories}
    />,
  );
  expect(view).not.toContain("待匹配转账");
  expect(view).toContain("最近自动入账");
  expect(renderToStaticMarkup(await dashboard.default({ searchParams: Promise.resolve({}) }))).not.toContain(
    "立即同步",
  );
  const html = renderToStaticMarkup(await hub.default({ searchParams: Promise.resolve({ tab: "sync" }) }));
  expect(html).toContain("自动入账");
  expect(html.indexOf("连接银行（Plaid）")).toBeLessThan(html.indexOf("上传 PDF / CSV"));
  vi.stubEnv("PLAID_ENABLED", "false");
  expect(renderToStaticMarkup(<AppNavigation />)).not.toContain("银行同步");
  expect(renderToStaticMarkup(await dashboard.default({ searchParams: Promise.resolve({}) }))).not.toContain(
    "连接银行，自动导入流水",
  );
  expect(renderToStaticMarkup(await accountPage.default())).not.toContain("连接银行");
  expect(
    renderToStaticMarkup(await hub.default({ searchParams: Promise.resolve({ tab: "sync" }) })),
  ).not.toContain("连接银行（Plaid）");
});
it.each([
  "payment thank you",
  "payment received",
  "autopay",
  "epay",
  "e-payment",
  "online payment",
  "ach pmt",
  "venmo",
  "transfer",
  "xfer",
  "to account 1234",
  "from account 1234",
])("recognizes the shared transfer keyword: %s", (description) => {
  expect(isTransferLike({ amount: "-10", accountType: "asset_cash", description })).toBe(true);
});
