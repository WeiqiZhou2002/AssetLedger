import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { bankAccount, bankTransaction, FakePlaid, plaidConfig as config } from "./helpers/plaid";
import type { BankTransaction } from "@/lib/bank-sync/types";
import { auditLogs, importRows, journalEntries } from "@/db/schema";
import { exchangeConnection, saveMapping } from "@/lib/bank-sync/connections";
import { syncConnection } from "@/lib/bank-sync/sync";
import { pendingWorkbench, setAutoPost } from "@/lib/bank-sync/pending";
import { stampAutoEntry } from "@/lib/bank-sync/auto-state";
import { clearingInput, linkLegs, unmatchedLegs } from "@/lib/bank-sync/transfer-legs";
import { isCashAdvanceSpend, isTransferLike } from "@/lib/bank-sync/transfer-config";
import { createAccount } from "@/lib/ledger/accounts";
import { createEntry, getEntry, updateEntryMeta } from "@/lib/ledger/entries";
import { accountBalance } from "@/lib/ledger/queries";
import { classifyTransaction } from "@/lib/bank-sync/classification";

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

async function connect(type: string, accountId: string, autoPost = true, secondAccountId?: string) {
  const client = new FakePlaid();
  client.item.id = `item-${accountId}`;
  client.accountRows = [
    bankAccount(accountId, type),
    ...(secondAccountId ? [bankAccount(secondAccountId)] : []),
  ];
  const result = await exchangeConnection(
    h.db,
    f.ownerId,
    client,
    config,
    {
      public_token: "synthetic-public",
      institution: { institution_id: "ins_synthetic", name: "Example Bank" },
      // These classification fixtures intentionally create separate Items at the same synthetic bank.
      allowDuplicate: true,
    },
    now,
  );
  await saveMapping(
    h.db,
    f.ownerId,
    result.connection.id,
    config,
    {
      importFromDate: "2026-10-01",
      accounts: result.accounts.map((row) => ({ id: row.id, accountId: row.plaidAccountId })),
    },
    now,
  );
  if (!autoPost) await setAutoPost(h.db, f.ownerId, result.connection.id, config, { autoPost });
  return { id: result.connection.id, client, accountId };
}
type Connection = Awaited<ReturnType<typeof connect>>;
function transaction(connection: Connection, id: string, changes: Partial<BankTransaction> = {}) {
  return bankTransaction(id, {
    accountId: connection.accountId,
    primary: null,
    merchantName: null,
    ...changes,
  });
}
async function sync(connection: Connection, added: BankTransaction[] = []) {
  connection.client.page = () => ({
    accounts: connection.client.accountRows,
    added,
    modified: [],
    removed: [],
    hasMore: false,
    nextCursor: `cursor-${connection.client.cursors.length}`,
    updateStatus: "HISTORICAL_UPDATE_COMPLETE",
  });
  return syncConnection(h.db, f.ownerId, connection.id, connection.client, config, now);
}
const rows = () => h.db.select().from(importRows).where(eq(importRows.ownerId, f.ownerId));
const entries = () => h.db.select().from(journalEntries).where(eq(journalEntries.ownerId, f.ownerId));
const balance = (id: string) => accountBalance(h.db, f.ownerId, id, "2026-10-31");
const pending = () => pendingWorkbench(h.db, f.ownerId, "sandbox");
const audits = (action: string) =>
  h.db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.ownerId, f.ownerId), eq(auditLogs.action, action)));

async function legacyLeg(connection: Connection, input: BankTransaction) {
  await sync(connection, [input]);
  const row = (await rows()).find((row) => row.providerTransactionId === input.id)!;
  const entry = await createEntry(h.db, f.ownerId, await clearingInput(h.db, f.ownerId, row));
  await h.db
    .update(journalEntries)
    .set({ providerAccountId: row.accountId, providerTransactionId: input.id })
    .where(and(eq(journalEntries.ownerId, f.ownerId), eq(journalEntries.id, entry.id)));
  await stampAutoEntry(h.db, f.ownerId, entry.id);
  await h.db
    .update(importRows)
    .set({
      journalEntryId: entry.id,
      autoPostState: "posted",
      decision: "approve",
      suggestedEntryType: "transfer",
      suggestedCategoryId: null,
    })
    .where(and(eq(importRows.ownerId, f.ownerId), eq(importRows.id, row.id)));
  return entry;
}

it("posts a keyword-free card return to the original merchant category, reducing spending without pending items", async () => {
  const card = await connect("credit", f.card.id);
  await sync(card, [
    transaction(card, "purchase", {
      amount: "80",
      name: "Example Store",
      merchantName: "Example Store",
      primary: "GENERAL_MERCHANDISE",
    }),
  ]);
  const purchase = await getEntry(h.db, f.ownerId, (await rows())[0].journalEntryId!);
  await updateEntryMeta(h.db, f.ownerId, purchase.id, {
    categories: [
      {
        postingId: purchase.postings.find((line) => line.categoryId)!.id,
        categoryId: f.category("电子产品"),
      },
    ],
  });
  await sync(card, [
    transaction(card, "return", {
      amount: "-30",
      name: "Example Store",
      merchantName: "Example Store",
      primary: "FOOD_AND_DRINK",
    }),
  ]);
  const row = (await rows()).find((row) => row.providerTransactionId === "return")!;
  const refund = await getEntry(h.db, f.ownerId, row.journalEntryId!);
  expect(refund.entryType).toBe("refund");
  expect(refund.benefitCredit).toBe(false);
  expect(refund.postings.find((line) => line.categoryId)).toMatchObject({
    amount: "-30.0000",
    categoryId: f.category("电子产品"),
  });
  expect(await balance(f.expense.id)).toBe("50.0000");
  expect(await balance(f.income.id)).toBe("0.0000");
  expect((await pending()).count).toBe(0);
});

it.each([
  ["Amazon-style merchant credit", null, "其他支出"],
  ["STATEMENT CREDIT", null, "其他支出"],
  ["CASHBACK", null, "其他支出"],
  ["CREDIT ADJUSTMENT", "GENERAL_MERCHANDISE", "其他支出"],
  ["PAYMENT REVERSAL", null, "其他支出"],
  ["Zelle transfer credit", "TRANSFER_OUT", "其他支出"],
])(
  "posts card credit %s as a refund using the PFC/fallback expense category",
  async (name, primary, category) => {
    const card = await connect("credit", f.card.id);
    await sync(card, [transaction(card, "credit", { amount: "-15", name: name!, primary })]);
    const entry = await getEntry(h.db, f.ownerId, (await rows())[0].journalEntryId!);
    expect(entry.entryType).toBe("refund");
    expect(entry.postings.find((line) => line.categoryId)?.categoryId).toBe(f.category(category!));
    expect(await balance(f.expense.id)).toBe("-15.0000");
    expect((await pending()).count).toBe(0);
  },
);

it.each([
  ["PAYMENT THANK YOU", null],
  ["Example credit", "LOAN_PAYMENTS"],
  ["Example credit", "TRANSFER_IN"],
  ["ONLINE CREDIT", "LOAN_PAYMENTS"],
])("still matches a card payment identified by %s / %s to its checking debit", async (name, primary) => {
  const bank = await connect("depository", f.bank.id);
  const card = await connect("credit", f.card.id);
  await sync(bank, [transaction(bank, "out", { amount: "100", name: "ACH PMT", date: "2026-10-19" })]);
  await sync(card, [transaction(card, "in", { amount: "-100", name: name!, primary, date: "2026-10-24" })]);
  const all = (await entries()).filter((entry) => entry.status === "confirmed");
  expect(all).toHaveLength(2);
  expect(all.every((entry) => entry.entryType === "credit_card_payment" && entry.transferMatchId)).toBe(true);
  expect(new Set(all.map((entry) => entry.transferMatchId)).size).toBe(1);
  expect(await balance(f.expense.id)).toBe("0.0000");
  expect(await balance(f.income.id)).toBe("0.0000");
  expect((await pending()).count).toBe(0);
});

it("reclassifies an untouched old card credit once, preserving balance, dates, provider evidence and review-mode protection", async () => {
  const card = await connect("credit", f.card.id, false);
  const old = await legacyLeg(
    card,
    transaction(card, "old-credit", {
      amount: "-40",
      name: "Example merchant",
      primary: "GENERAL_MERCHANDISE",
    }),
  );
  await sync(card);
  expect((await getEntry(h.db, f.ownerId, old.id)).status).toBe("confirmed");
  await setAutoPost(h.db, f.ownerId, card.id, config, { autoPost: true });
  await sync(card);
  const row = (await rows())[0];
  const refund = await getEntry(h.db, f.ownerId, row.journalEntryId!);
  expect(refund).toMatchObject({
    entryType: "refund",
    benefitCredit: false,
    replacesEntryId: old.id,
    eventDate: old.eventDate,
    postedDate: old.postedDate,
    providerTransactionId: "old-credit",
    autoPostOwnerEdited: false,
  });
  expect((await getEntry(h.db, f.ownerId, old.id)).status).toBe("voided");
  expect(await balance(f.card.id)).toBe("40.0000");
  expect(await balance(f.bank.id)).toBe("0.0000");
  expect(await balance(f.expense.id)).toBe("-40.0000");
  expect((await pending()).count).toBe(0);
  expect(await audits("auto_reclassified_refund")).toHaveLength(1);
  await sync(card);
  expect(await entries()).toHaveLength(2);
  expect((await rows())[0].journalEntryId).toBe(refund.id);
  expect(await audits("auto_reclassified_refund")).toHaveLength(1);
});

it("leaves owner-edited and already-matched old card credit legs alone", async () => {
  const card = await connect("credit", f.card.id, false);
  const bank = await connect("depository", f.bank.id, false);
  const edited = await legacyLeg(
    card,
    transaction(card, "edited", { amount: "-20", name: "Example credit" }),
  );
  await updateEntryMeta(h.db, f.ownerId, edited.id, { notes: "Owner reviewed" });
  const matched = await legacyLeg(
    card,
    transaction(card, "matched", { amount: "-100", name: "Example merchant credit" }),
  );
  const peer = await legacyLeg(bank, transaction(bank, "bank-leg", { amount: "100", name: "ACH PMT" }));
  const legs = await unmatchedLegs(h.db, f.ownerId, "sandbox");
  await h.db.transaction((db) =>
    linkLegs(
      db,
      f.ownerId,
      legs.find((leg) => leg.id === matched.id)!,
      legs.find((leg) => leg.id === peer.id)!,
      true,
    ),
  );
  await setAutoPost(h.db, f.ownerId, card.id, config, { autoPost: true });
  await sync(card);
  expect((await entries()).every((entry) => entry.status === "confirmed")).toBe(true);
  expect(await entries()).toHaveLength(3);
  expect(await audits("auto_reclassified_refund")).toHaveLength(0);
});

it("never matches a card refund to an equal checking withdrawal", async () => {
  const bank = await connect("depository", f.bank.id);
  const card = await connect("credit", f.card.id);
  await sync(bank, [transaction(bank, "out", { amount: "100", name: "ACH PMT" })]);
  await sync(card, [transaction(card, "credit", { amount: "-100", name: "STATEMENT CREDIT" })]);
  expect((await entries()).every((entry) => !entry.transferMatchId)).toBe(true);
  expect(await balance(f.expense.id)).toBe("0.0000");
  expect((await pending()).transfers.map((leg) => leg.accountId)).toEqual([]);
});

it("posts unmatched Zelle outgoing/incoming as expense/income without a pending transfer", async () => {
  const bank = await connect("depository", f.bank.id);
  await sync(bank, [
    transaction(bank, "out", { amount: "30", name: "Zelle to Alex Sample", primary: "TRANSFER_OUT" }),
    transaction(bank, "in", { amount: "-50", name: "Zelle from Casey Sample", primary: "TRANSFER_IN" }),
  ]);
  expect((await entries()).map((entry) => entry.entryType).sort()).toEqual(["expense", "income"]);
  expect(await balance(f.expense.id)).toBe("30.0000");
  expect(await balance(f.income.id)).toBe("-50.0000");
  expect((await pending()).count).toBe(0);
  for (const row of await rows()) {
    const entry = await getEntry(h.db, f.ownerId, row.journalEntryId!);
    expect(entry.postings.find((line) => line.categoryId)?.categoryId).toBe(
      f.category(entry.entryType === "expense" ? "其他支出" : "其他收入"),
    );
  }
});

async function secondBank() {
  return createAccount(h.db, f.ownerId, { name: "Example Savings", type: "asset_cash", currency: "USD" });
}
it("matches both Zelle sides before posting a single batch, without provisional income/expense or void history", async () => {
  const other = await secondBank();
  const bank = await connect("depository", f.bank.id, true, other.id);
  await sync(bank, [
    transaction(bank, "out", { amount: "75", name: "Zelle transfer" }),
    transaction(bank, "in", { accountId: other.id, amount: "-75", name: "Zelle transfer" }),
  ]);
  expect(await entries()).toHaveLength(2);
  expect(
    (await entries()).every(
      (entry) => entry.entryType === "transfer" && entry.status === "confirmed" && entry.transferMatchId,
    ),
  ).toBe(true);
  expect(await audits("entry.void")).toHaveLength(0);
  expect(await balance(f.expense.id)).toBe("0.0000");
  expect(await balance(f.income.id)).toBe("0.0000");
  expect((await pending()).count).toBe(0);
});

it("does not guess between equal Zelle candidates, including an owner-edited candidate", async () => {
  const other = await secondBank();
  const bank = await connect("depository", f.bank.id);
  const savings = await connect("depository", other.id);
  await sync(savings, [
    transaction(savings, "in1", { amount: "-75", name: "Zelle from Alex Sample" }),
    transaction(savings, "in2", { amount: "-75", name: "Zelle from Casey Sample" }),
  ]);
  await updateEntryMeta(h.db, f.ownerId, (await entries())[0].id, { notes: "Owner reviewed" });
  await sync(bank, [transaction(bank, "out", { amount: "75", name: "Zelle outgoing" })]);
  expect((await entries()).every((entry) => entry.status === "confirmed" && !entry.transferMatchId)).toBe(
    true,
  );
  expect(await entries()).toHaveLength(3);
  expect(await balance(f.expense.id)).toBe("75.0000");
  expect(await balance(f.income.id)).toBe("-150.0000");
  expect((await pending()).suggestions).toHaveLength(2);
  expect((await pending()).count).toBe(2);
});

it("uses Zelle counterparty history ahead of the generic expense category", async () => {
  const bank = await connect("depository", f.bank.id);
  await sync(bank, [transaction(bank, "prior", { amount: "30", name: "Zelle Alex Sample" })]);
  const prior = await getEntry(h.db, f.ownerId, (await rows())[0].journalEntryId!);
  await updateEntryMeta(h.db, f.ownerId, prior.id, {
    categories: [
      { postingId: prior.postings.find((line) => line.categoryId)!.id, categoryId: f.category("餐饮") },
    ],
  });
  await sync(bank, [
    transaction(bank, "next", { amount: "40", name: "Zelle Alex Sample", primary: "GENERAL_MERCHANDISE" }),
  ]);
  const next = (await rows()).find((row) => row.providerTransactionId === "next")!;
  expect(
    (await getEntry(h.db, f.ownerId, next.journalEntryId!)).postings.find((line) => line.categoryId)
      ?.categoryId,
  ).toBe(f.category("餐饮"));
});

it("rematches an earlier untouched Zelle expense on a later sync, preserving each date and remaining idempotent", async () => {
  const other = await secondBank();
  const bank = await connect("depository", f.bank.id);
  const savings = await connect("depository", other.id);
  await sync(bank, [
    transaction(bank, "out", { amount: "75", name: "Zelle to own account", date: "2026-10-19" }),
  ]);
  const old = (await entries())[0];
  expect(old.entryType).toBe("expense");
  await sync(savings, [
    transaction(savings, "in", { amount: "-75", name: "Zelle from own account", date: "2026-10-24" }),
  ]);
  const current = (await entries()).filter((entry) => entry.status === "confirmed");
  expect(current).toHaveLength(2);
  expect(current.every((entry) => entry.entryType === "transfer" && entry.transferMatchId)).toBe(true);
  expect(current.map((entry) => entry.postedDate).sort()).toEqual(["2026-10-19", "2026-10-24"]);
  expect(current.some((entry) => entry.replacesEntryId === old.id)).toBe(true);
  expect(await balance(f.expense.id)).toBe("0.0000");
  expect(await balance(f.income.id)).toBe("0.0000");
  expect(await audits("auto_rematched_transfer")).toHaveLength(2);
  await sync(savings);
  expect(await entries()).toHaveLength(3);
  expect(await audits("auto_rematched_transfer")).toHaveLength(2);
});

it("does not rematch an owner-edited Zelle expense or mistake ordinary payroll for a counterpart", async () => {
  const other = await secondBank();
  const bank = await connect("depository", f.bank.id);
  const savings = await connect("depository", other.id);
  await sync(bank, [transaction(bank, "out", { amount: "75", name: "Zelle to Alex Sample" })]);
  const old = (await entries())[0];
  await updateEntryMeta(h.db, f.ownerId, old.id, { notes: "Reviewed by owner" });
  await sync(savings, [transaction(savings, "in", { amount: "-75", name: "Zelle received" })]);
  await sync(bank, [transaction(bank, "other-out", { amount: "50", name: "Zelle to friend" })]);
  await sync(savings, [transaction(savings, "payroll", { amount: "-50", name: "Example payroll" })]);
  expect((await entries()).every((entry) => entry.status === "confirmed" && !entry.transferMatchId)).toBe(
    true,
  );
  expect(await entries()).toHaveLength(4);
  expect(await audits("auto_rematched_transfer")).toHaveLength(0);
  expect((await pending()).suggestions).toHaveLength(2);
  expect((await pending()).count).toBe(2);
});

it.each(["ATM DEPOSIT", "CASH DEPOSIT", "BRANCH DEPOSIT", "MOBILE DEPOSIT"])(
  "classifies %s ahead of PFC TRANSFER_IN as other income",
  async (name) => {
    const bank = await connect("depository", f.bank.id);
    await sync(bank, [transaction(bank, "deposit", { amount: "-40", name, primary: "TRANSFER_IN" })]);
    const entry = await getEntry(h.db, f.ownerId, (await rows())[0].journalEntryId!);
    expect(entry.entryType).toBe("income");
    expect(entry.postings.find((line) => line.categoryId)?.categoryId).toBe(f.category("其他收入"));
    expect(await balance(f.income.id)).toBe("-40.0000");
    expect((await pending()).count).toBe(0);
  },
);

it.each([
  ["Zelle to Alex Sample", "20", "expense"],
  ["Zelle from Alex Sample", "-20", "income"],
  ["ATM DEPOSIT", "-20", "income"],
  ["Cash advance", "20", "expense"],
])("reclassifies an untouched old %s clearing leg once", async (name, amount, type) => {
  const bank = await connect("depository", f.bank.id, false);
  const old = await legacyLeg(bank, transaction(bank, "old", { name, amount, primary: "TRANSFER_IN" }));
  await setAutoPost(h.db, f.ownerId, bank.id, config, { autoPost: true });
  await sync(bank);
  const entry = await getEntry(h.db, f.ownerId, (await rows())[0].journalEntryId!);
  expect(entry).toMatchObject({ entryType: type, replacesEntryId: old.id });
  expect((await pending()).count).toBe(0);
  expect(await audits("auto_reclassified")).toHaveLength(1);
  await sync(bank);
  expect(await entries()).toHaveLength(2);
  expect(await audits("auto_reclassified")).toHaveLength(1);
});

it.each([
  "payment thank you",
  "payment received",
  "autopay",
  "epay",
  "e-payment",
  "online payment",
  "ach pmt",
])("recognizes the explicit card payment keyword %s", (description) => {
  expect(isTransferLike({ amount: "10", accountType: "liability_credit_card", description })).toBe(true);
});

it.each(["cash advance", "CASH-ADVANCE"])(
  "posts %s checking outflows as spending without pairing",
  async (name) => {
    const bank = await connect("depository", f.bank.id);
    const card = await connect("credit", f.card.id);
    await sync(bank, [
      transaction(bank, "advance", {
        amount: "40",
        name: `${name} to account 1234`,
        primary: "TRANSFER_OUT",
      }),
    ]);
    await sync(card, [
      transaction(card, "unrelated", { amount: "-40", name: "payment from account", primary: "TRANSFER_IN" }),
    ]);
    const row = (await rows()).find((row) => row.providerTransactionId === "advance")!;
    expect(row.direction).toBe("charge");
    const entry = await getEntry(h.db, f.ownerId, row.journalEntryId!);
    expect(entry).toMatchObject({ entryType: "expense", transferMatchId: null });
    expect(entry.postings.find((line) => line.categoryId)?.categoryId).toBe(f.category("其他支出"));
    expect(await balance(f.expense.id)).toBe("40.0000");
    expect((await unmatchedLegs(h.db, f.ownerId)).some((leg) => leg.id === entry.id)).toBe(false);
  },
);
it("classifies a cash advance found only in the merchant ahead of transfer categories", () => {
  const row = bankTransaction("synthetic", {
    amount: "30",
    name: "Teller",
    merchantName: "Cash Advance",
    primary: "TRANSFER_OUT",
  });
  expect(classifyTransaction(row, "depository")).toEqual({
    direction: "charge",
    type: "expense",
    category: "其他支出",
  });
  expect(classifyTransaction({ ...row, amount: "-30", primary: "TRANSFER_IN" }, "depository").type).toBe(
    "transfer",
  );
  expect(classifyTransaction(row, "credit").type).toBe("transfer");
});
it.each([
  ["asset_cash", "-40", true],
  ["asset_brokerage_cash", "-40", true],
  ["asset_cash", "40", false],
  ["liability_credit_card", "-40", false],
  ["liability_credit_card", "40", false],
  ["asset_cash", "0", false],
])("cash advance detection respects %s amount %s", (accountType, amount, spend) => {
  const input = { accountType, amount, description: "Cash advance transfer", primary: "TRANSFER_OUT" };
  expect(isCashAdvanceSpend(input)).toBe(spend);
  expect(isTransferLike(input)).toBe(!spend && !(accountType === "liability_credit_card" && amount === "40"));
});
it("falls back unmatched money-in cash advances and credit-card cash advances to income/expense", async () => {
  const bank = await connect("depository", f.bank.id);
  const card = await connect("credit", f.card.id);
  await sync(bank, [
    transaction(bank, "incoming", { amount: "-60", name: "Cash advance", primary: "TRANSFER_IN" }),
  ]);
  await sync(card, [
    transaction(card, "card-out", { amount: "70", name: "Cash advance", primary: "TRANSFER_OUT" }),
  ]);
  expect((await entries()).map((entry) => entry.entryType).sort()).toEqual(["expense", "income"]);
  expect(await balance(f.expense.id)).toBe("70.0000");
  expect(await balance(f.income.id)).toBe("-60.0000");
  expect((await pending()).transfers).toHaveLength(0);
});
