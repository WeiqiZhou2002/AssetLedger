import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { bankAccount, bankTransaction, FakePlaid, plaidConfig as config } from "./helpers/plaid";
import type { BankTransaction } from "@/lib/bank-sync/types";
import {
  bankConnections,
  importRows,
  journalEntries,
  auditLogs,
  statements,
  users,
  categories,
  accounts,
} from "@/db/schema";
import { exchangeConnection, saveMapping } from "@/lib/bank-sync/connections";
import { syncConnection } from "@/lib/bank-sync/sync";
import { setAutoPost, pendingWorkbench } from "@/lib/bank-sync/pending";
import { clearingInput } from "@/lib/bank-sync/transfer-legs";
import { stampAutoEntry, untouched } from "@/lib/bank-sync/auto-state";
import { entryMatching, resolveEntryMatching } from "@/lib/bank-sync/matching";
import { createQuickEntry, buildPostings } from "@/lib/ledger/builders";
import { createEntry, confirmEntry, getEntry, updateEntryMeta, voidEntry } from "@/lib/ledger/entries";
import { createAccount } from "@/lib/ledger/accounts";
import { accountBalance } from "@/lib/ledger/queries";
import { benefitInput } from "@/lib/benefits/input";
import { detectBenefit, type BenefitFamily } from "@/lib/benefits/config";
import { BENEFIT_VERSION } from "@/lib/bank-sync/benefit-rescan";
import { benefitDetail, editBenefit } from "@/lib/benefits/service";
import { benefitOverview } from "@/lib/benefits/queries";
import { BenefitOverview, BenefitDetails } from "@/components/benefits/overview";
import { BenefitEditor } from "@/components/benefits/editor";
import { parseCsv, amexMapping } from "@/lib/imports/csv";
import { applyParsedStatement } from "@/lib/imports/processing";
import { statementRows } from "@/lib/imports/store";
import { updateImportRows } from "@/lib/imports/review";
import { approveRows } from "@/lib/imports/approval";
import { createSession } from "@/lib/auth/session";

let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
const now = new Date("2026-10-24T12:00:00Z");
vi.mock("@/db/client", () => ({ getDb: () => h.db }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const route = await import("@/app/api/transactions/[id]/benefit/route");
const overviewRoute = await import("@/app/api/benefits/route");
beforeAll(async () => {
  h = await createTestDb();
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("APP_SECRET", config.APP_SECRET);
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic/test");
});
afterAll(async () => {
  await h.client.close();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
});
async function connect(accountId = f.card.id, autoPost = true) {
  const client = new FakePlaid();
  client.item.id = `item-${accountId}`;
  client.accountRows = [bankAccount(accountId, accountId === f.card.id ? "credit" : "depository")];
  const result = await exchangeConnection(
    h.db,
    f.ownerId,
    client,
    config,
    {
      public_token: "synthetic-public",
      institution: { institution_id: `ins_${accountId}`, name: "Example Bank" },
    },
    now,
  );
  await saveMapping(
    h.db,
    f.ownerId,
    result.connection.id,
    config,
    { importFromDate: "2026-01-01", accounts: [{ id: result.accounts[0].id, accountId }] },
    now,
  );
  if (!autoPost) await setAutoPost(h.db, f.ownerId, result.connection.id, config, { autoPost });
  return { id: result.connection.id, client, accountId };
}
type Connection = Awaited<ReturnType<typeof connect>>;
function tx(c: Connection, id: string, amount: string, name: string, extra: Partial<BankTransaction> = {}) {
  return bankTransaction(id, {
    accountId: c.accountId,
    amount,
    name,
    merchantName: name,
    primary: null,
    date: "2026-10-22",
    authorizedDate: "2026-10-22",
    ...extra,
  });
}
async function sync(c: Connection, added: BankTransaction[] = []) {
  c.client.page = () => ({
    accounts: c.client.accountRows,
    added,
    modified: [],
    removed: [],
    hasMore: false,
    nextCursor: `cursor-${c.client.cursors.length}`,
    updateStatus: "HISTORICAL_UPDATE_COMPLETE",
  });
  return syncConnection(h.db, f.ownerId, c.id, c.client, config, now);
}
async function entryFor(providerId: string) {
  const [row] = await h.db
    .select()
    .from(importRows)
    .where(and(eq(importRows.ownerId, f.ownerId), eq(importRows.providerTransactionId, providerId)));
  return getEntry(h.db, f.ownerId, row.journalEntryId!);
}
const balance = (id: string) => accountBalance(h.db, f.ownerId, id, "2026-10-31");
const expense = (
  amount: string,
  category: string,
  description: string,
  date = "2026-10-10",
  cardId = f.card.id,
) =>
  createQuickEntry(h.db, f.ownerId, {
    type: "expense",
    amount,
    fromAccountId: cardId,
    categoryId: f.category(category),
    eventDate: date,
    merchant: description,
    description,
  });
async function benefit(amount: string, family: BenefitFamily, date = "2026-10-22", accountId = f.card.id) {
  return createEntry(
    h.db,
    f.ownerId,
    await benefitInput(h.db, f.ownerId, { accountId, amount, currency: "USD", eventDate: date, family }),
  );
}
it("records an annual travel center credit without linking a purchase and offsets spending exactly", async () => {
  const c = await connect();
  await sync(c, [
    tx(c, "credit", "-300", "ANNUAL TRAVEL CENTER CREDIT", { primary: "TRANSFER_IN" }),
    tx(c, "hotel", "300", "TRAVELCENTER HOTEL", { primary: "TRAVEL", date: "2026-10-12" }),
  ]);
  const credit = await entryFor("credit");
  expect(credit).toMatchObject({
    entryType: "refund",
    benefitCredit: true,
    benefitFamily: "travel",
    refundOfEntryId: null,
    transferMatchId: null,
  });
  expect(credit.postings.find((line) => line.categoryId)?.categoryId).toBe(f.category("旅行"));
  expect(await balance(f.expense.id)).toBe("0.0000");
  expect(await balance(f.income.id)).toBe("0.0000");
});
it("records repeated benefits without purchase capacity or pending suggestions", async () => {
  await expense("22", "交通", "UBER RIDE");
  for (let n = 0; n < 3; n++) expect((await benefit("15", "rideshare")).refundOfEntryId).toBeNull();
  await expense("25", "餐饮", "Example Cafe A");
  await expense("25", "餐饮", "Example Cafe B");
  const c = await connect();
  await sync(c, [tx(c, "dining", "-25", "DINING CREDIT")]);
  const credit = await entryFor("dining");
  expect(credit.refundOfEntryId).toBeNull();
  expect(credit.postings.find((line) => line.categoryId)?.categoryId).toBe(f.category("餐饮"));
  const pending = await pendingWorkbench(h.db, f.ownerId, "sandbox");
  expect(pending.count).toBe(0);
  expect(pending).not.toHaveProperty("benefits");
  expect(await benefitDetail(h.db, f.ownerId, credit.id)).toEqual({ enabled: true, family: "dining" });
  await expect(
    editBenefit(h.db, f.ownerId, credit.id, { action: "link", purchaseId: null }),
  ).rejects.toThrow();
});
it.each(["STATEMENT CREDIT", "AMEX OFFERS CASHBACK", "CREDIT ADJUSTMENT"])(
  "%s respects specific-family precedence and generic PFC payment protection",
  async (name) => {
    const c = await connect();
    const b = await connect(f.bank.id);
    await sync(b, [tx(b, "out", "50", "Example Bank PAYMENT TO")]);
    await sync(c, [tx(c, "benefit", "-50", `Example Bank ${name}`, { primary: "LOAN_PAYMENTS" })]);
    const entry = await entryFor("benefit");
    if (name === "AMEX OFFERS CASHBACK") {
      expect(entry.entryType).toBe("refund");
      expect(entry.benefitCredit).toBe(false);
      expect(entry.transferMatchId).toBeNull();
    } else {
      expect(entry.entryType).toBe("credit_card_payment");
      expect(entry.benefitCredit).toBe(false);
      expect(entry.transferMatchId).toBeTruthy();
    }
    // The unmatched checking debit now posts as an expense, offsetting the benefit refund.
    expect(await balance(f.expense.id)).toBe("0.0000");
  },
);
it("payment keywords beat benefit wording and still match a checking debit", async () => {
  const c = await connect();
  const b = await connect(f.bank.id);
  await sync(b, [tx(b, "payment-out", "75", "ONLINE PAYMENT")]);
  await sync(c, [
    tx(c, "payment-in", "-75", "PAYMENT THANK YOU STATEMENT CREDIT", { primary: "LOAN_PAYMENTS" }),
  ]);
  const entry = await entryFor("payment-in");
  expect(entry).toMatchObject({ entryType: "credit_card_payment", benefitCredit: false });
  expect(entry.transferMatchId).toBeTruthy();
  expect(await balance(f.expense.id)).toBe("0.0000");
});
async function oldClearing(c: Connection, name: string, providerId: string) {
  await sync(c, [tx(c, providerId, "-30", name, { primary: "TRANSFER_IN" })]);
  const [row] = await h.db.select().from(importRows).where(eq(importRows.providerTransactionId, providerId));
  const entry = await createEntry(h.db, f.ownerId, await clearingInput(h.db, f.ownerId, row));
  await h.db
    .update(journalEntries)
    .set({ providerAccountId: f.card.id, providerTransactionId: providerId })
    .where(eq(journalEntries.id, entry.id));
  await stampAutoEntry(h.db, f.ownerId, entry.id);
  await h.db
    .update(importRows)
    .set({ journalEntryId: entry.id, autoPostState: "posted", decision: "approve" })
    .where(eq(importRows.id, row.id));
  return entry;
}
it("rescans old clearing once, preserving legacy fingerprints and edited entries", async () => {
  const c = await connect(f.card.id, false);
  const old = await oldClearing(c, "UBER CASH", "old");
  const edited = await oldClearing(c, "DINING CREDIT", "edited");
  expect(untouched(await getEntry(h.db, f.ownerId, old.id))).toBe(true);
  await updateEntryMeta(h.db, f.ownerId, edited.id, { notes: "Owner checked" });
  await setAutoPost(h.db, f.ownerId, c.id, config, { autoPost: true });
  await sync(c);
  const converted = await entryFor("old");
  expect(converted).toMatchObject({
    entryType: "refund",
    benefitCredit: true,
    benefitFamily: "rideshare",
    replacesEntryId: old.id,
  });
  expect((await getEntry(h.db, f.ownerId, old.id)).status).toBe("voided");
  expect((await getEntry(h.db, f.ownerId, edited.id)).benefitCredit).toBe(false);
  const before = await h.db.select().from(journalEntries);
  await sync(c);
  expect(await h.db.select().from(journalEntries)).toEqual(before);
  expect(
    await h.db.select().from(auditLogs).where(eq(auditLogs.action, "auto_reclassified_benefit")),
  ).toHaveLength(1);
  expect((await h.db.select().from(bankConnections))[0].benefitVersion).toBe(BENEFIT_VERSION);
});
it("manual marking preserves amounts and historical links, selects family category, and isolates owners", async () => {
  const purchase = await expense("30", "购物", "Example shop");
  const credit = await createQuickEntry(h.db, f.ownerId, {
    type: "refund",
    amount: "30",
    toAccountId: f.card.id,
    categoryId: f.category("购物"),
    eventDate: "2026-10-22",
    refundOfEntryId: purchase.id,
  });
  await editBenefit(h.db, f.ownerId, credit.id, { action: "set", enabled: true, family: "dining" });
  let entry = await getEntry(h.db, f.ownerId, credit.id);
  expect(entry).toMatchObject({ benefitCredit: true, benefitFamily: "dining", refundOfEntryId: purchase.id });
  expect(entry.postings.find((line) => line.categoryId)?.categoryId).toBe(f.category("餐饮"));
  await editBenefit(h.db, f.ownerId, credit.id, { action: "set", enabled: false });
  entry = await getEntry(h.db, f.ownerId, credit.id);
  expect(entry).toMatchObject({ benefitCredit: false, benefitFamily: null, refundOfEntryId: purchase.id });
  expect(await balance(f.card.id)).toBe("0.0000");
  await expect(benefitDetail(h.db, f.otherId, credit.id)).rejects.toThrow("不存在");
  await expect(editBenefit(h.db, f.otherId, credit.id, { action: "set", enabled: true })).rejects.toThrow(
    "不存在",
  );
});
it("explicit conversion unpairs a matched credit while the rescan leaves it alone", async () => {
  const c = await connect(f.card.id, false);
  const card = await oldClearing(c, "STATEMENT CREDIT", "matched");
  const input = await clearingInput(h.db, f.ownerId, {
    accountId: f.bank.id,
    amount: "-30",
    currency: "USD",
    transactionDate: "2026-10-22",
    postedDate: "2026-10-22",
    descriptionRaw: "BANK TRANSFER",
    merchantNormalized: "bank transfer",
  });
  const bank = await createEntry(h.db, f.ownerId, input);
  await resolveEntryMatching(h.db, f.ownerId, card.id, { action: "match", counterpartEntryId: bank.id });
  // Restore untouched fingerprints to emulate a legacy automatically matched pair.
  await h.db
    .update(journalEntries)
    .set({ autoPostOwnerEdited: false })
    .where(eq(journalEntries.ownerId, f.ownerId));
  await stampAutoEntry(h.db, f.ownerId, card.id);
  await stampAutoEntry(h.db, f.ownerId, bank.id);
  await setAutoPost(h.db, f.ownerId, c.id, config, { autoPost: true });
  await sync(c);
  expect((await getEntry(h.db, f.ownerId, card.id)).transferMatchId).toBeTruthy();
  const result = await editBenefit(h.db, f.ownerId, card.id, {
    action: "set",
    enabled: true,
    family: "generic",
  });
  expect((await getEntry(h.db, f.ownerId, result.entryId)).entryType).toBe("refund");
  expect((await getEntry(h.db, f.ownerId, bank.id)).transferMatchId).toBeNull();
  expect((await getEntry(h.db, f.ownerId, bank.id)).status).toBe("voided");
  const [fallback] = await h.db
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.replacesEntryId, bank.id));
  expect(fallback.entryType).toBe("expense");
  expect((await entryMatching(h.db, f.ownerId, fallback.id)).eligible).toBe(true);
});
it("benefit drafts confirm without consuming ordinary refund purchase capacity", async () => {
  const purchase = await expense("100", "旅行", "Example Hotel");
  await createQuickEntry(h.db, f.ownerId, {
    type: "refund",
    amount: "40",
    toAccountId: f.card.id,
    categoryId: f.category("旅行"),
    eventDate: "2026-10-12",
    refundOfEntryId: purchase.id,
  });
  const draftInput = await benefitInput(h.db, f.ownerId, {
    accountId: f.card.id,
    amount: "60",
    currency: "USD",
    eventDate: "2026-10-22",
    family: "travel",
  });
  const draft = await createEntry(h.db, f.ownerId, { ...draftInput, status: "draft" });
  expect(draft.refundOfEntryId).toBeNull();
  const extra = await benefit("1", "travel");
  expect(extra.refundOfEntryId).toBeNull();
  await confirmEntry(h.db, f.ownerId, draft.id);
  expect((await getEntry(h.db, f.ownerId, draft.id)).status).toBe("confirmed");
});
it("stats separate cards, years, families and rolling windows without income", async () => {
  const card = await createAccount(h.db, f.ownerId, {
    name: "Another synthetic card",
    type: "liability_credit_card",
    currency: "USD",
  });
  await benefit("10", "travel", "2025-11-01");
  await benefit("20", "rideshare", "2026-02-01");
  await benefit("30", "offer", "2026-09-01", card.id);
  await benefit("50", "travel", "2025-01-01");
  const data = await benefitOverview(h.db, f.ownerId, "2026-10-24");
  expect(data.cards.find((row) => row.accountId === f.card.id)).toMatchObject({
    annual: "20.0000",
    rolling: "30.0000",
  });
  expect(data.cards.find((row) => row.accountId === card.id)).toMatchObject({
    annual: "0.0000",
    rolling: "0.0000",
  });
  expect(
    (await benefitOverview(h.db, f.ownerId, "2026-10-24", "2025")).cards.find(
      (row) => row.accountId === f.card.id,
    )?.annual,
  ).toBe("60.0000");
  expect((await benefitOverview(h.db, f.otherId, "2026-10-24")).cards).toHaveLength(0);
  expect(await balance(f.income.id)).toBe("0.0000");
  const html = renderToStaticMarkup(<BenefitOverview data={data} />);
  expect(html).toContain("权益统计年份");
  expect(html).not.toContain("关联原消费");
  expect(
    renderToStaticMarkup(
      <BenefitDetails card={data.cards.find((card) => card.accountId === f.card.id)!} year={data.year} />,
    ),
  ).toContain("/activity?entryId=");
  expect(
    renderToStaticMarkup(
      <BenefitEditor
        entryId="synthetic"
        enabled={false}
        isRefund={false}
        initialFamily="generic"
        onSaved={() => {}}
      />,
    ),
  ).toContain("改为权益报销");
});
it.each(["pdf", "csv"])(
  "%s review suggests benefits without auto-approval, then records without linking at approval",
  async (kind) => {
    await expense("15", "交通", "UBER RIDE");
    const [statement] = await h.db
      .insert(statements)
      .values({
        ownerId: f.ownerId,
        accountId: f.card.id,
        fileSha256: "a".repeat(64),
        originalFilename: `synthetic.${kind}`,
        mime: kind === "pdf" ? "application/pdf" : "text/csv",
        sizeBytes: 100,
      })
      .returning();
    const parsed = parseCsv(
      new TextEncoder().encode("Date,Receipt,Description,Amount\n10/22/2026,,UBER CASH,-15.00\n"),
      amexMapping,
      f.card,
    );
    await applyParsedStatement(h.db, f.ownerId, statement.id, {
      statement_type: "credit_card",
      currency: "USD",
      page_count: 1,
      parser_version: "1",
      summary: {},
      diagnostics: [],
      transaction_lines: [],
      parser: kind === "pdf" ? "synthetic-pdf" : "csv",
      entries: parsed.entries.map((row) => ({
        ...row,
        direction: kind === "pdf" ? "credit" : row.direction,
      })),
    });
    const [row] = await statementRows(h.db, f.ownerId, statement.id);
    expect(row).toMatchObject({
      suggestedEntryType: "refund",
      suggestedCategoryId: f.category("交通"),
      journalEntryId: null,
    });
    expect(row.softNotes.join(" ")).toContain("权益报销建议");
    await updateImportRows(h.db, f.ownerId, statement.id, {
      rowIds: [row.id],
      changes: { decision: "approve" },
    });
    const result = await approveRows(h.db, f.ownerId, statement.id, {
      rowIds: [row.id],
      idempotencyKey: "synthetic-benefit-approve",
    });
    expect(await getEntry(h.db, f.ownerId, result[0].entryId)).toMatchObject({
      benefitCredit: true,
      benefitFamily: "rideshare",
      refundOfEntryId: null,
    });
  },
);
it("benefit metadata API enforces auth, origin, owner and returns metadata without purchase candidates", async () => {
  const entry = await benefit("15", "dining");
  const context = { params: Promise.resolve({ id: entry.id }) };
  const url = `http://localhost:3000/api/transactions/${entry.id}/benefit`;
  expect((await route.GET(new NextRequest(url), context)).status).toBe(401);
  const session = await createSession(h.db, f.ownerId, { ipHash: "test", userAgent: "synthetic" });
  const cookie = `al_session=${session.token}`;
  expect(
    (
      await route.POST(
        new NextRequest(url, {
          method: "POST",
          headers: { cookie, origin: "https://bad.example" },
          body: JSON.stringify({ action: "set", enabled: false }),
        }),
        context,
      )
    ).status,
  ).toBe(403);
  const response = await route.GET(new NextRequest(url, { headers: { cookie } }), context);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ enabled: true, family: "dining" });
});
it.each([
  ["TRAVEL CREDIT", "travel"],
  ["ANNUAL TRAVEL CENTER CREDIT", "travel"],
  ["RESY", "dining"],
  ["DOORDASH CREDIT", "dining"],
  ["DASHPASS CREDIT", "dining"],
  ["UBER CASH", "rideshare"],
  ["LYFT CREDIT", "rideshare"],
  ["AIRLINE INCIDENTAL CREDIT", "airline"],
  ["FHR CREDIT", "hotel"],
  ["THE HOTEL COLLECTION CREDIT", "hotel"],
  ["DIGITAL ENTERTAINMENT", "entertainment"],
  ["STREAMING CREDIT", "entertainment"],
  ["SAKS CREDIT", "shopping"],
  ["WALMART+ CREDIT", "shopping"],
  ["CLEAR", "travel-program"],
  ["GLOBAL ENTRY", "travel-program"],
  ["TSA PRECHECK", "travel-program"],
  ["EQUINOX", "fitness"],
  ["Platinum Wireless Credit", "wireless"],
  ["AMEX WIRELESS CREDIT", "wireless"],
  ["Wireless Telephone Credit", "wireless"],
  ["Wireless Telephone Service Credit", "wireless"],
  ["Cell Phone Credit", "wireless"],
  ["Cellular Phone Credit", "wireless"],
  ["Mobile Phone Credit", "wireless"],
  ["Wireless Service Credit", "wireless"],
  ["CASHBACK OFFER", null],
  ["REIMB", "generic"],
])("detects %s only on card money-in", (description, family) => {
  expect(detectBenefit({ accountType: "liability_credit_card", amount: "1", description })).toBe(family);
  expect(detectBenefit({ accountType: "asset_cash", amount: "1", description })).toBeNull();
  expect(detectBenefit({ accountType: "liability_credit_card", amount: "-1", description })).toBeNull();
});

it.each([
  ["STREAMING CREDIT", "entertainment", "娱乐"],
  ["Platinum Wireless Credit", "wireless", "水电网络"],
])(
  "current rescan flags an untouched %s refund without replacing it and the second sync is a no-op",
  async (description, family, category) => {
    const c = await connect(f.card.id, false);
    await sync(c, [tx(c, "plain", "-12", description)]);
    const [row] = await h.db.select().from(importRows);
    const input = await buildPostings(h.db, f.ownerId, "refund", {
      amount: "12",
      toAccountId: f.card.id,
      categoryId: f.category("其他支出"),
      eventDate: "2026-10-22",
      description,
    });
    const entry = await createEntry(h.db, f.ownerId, input);
    await stampAutoEntry(h.db, f.ownerId, entry.id);
    await h.db
      .update(importRows)
      .set({ journalEntryId: entry.id, autoPostState: "posted", decision: "approve" })
      .where(eq(importRows.id, row.id));
    await setAutoPost(h.db, f.ownerId, c.id, config, { autoPost: true });
    await h.db.update(bankConnections).set({ benefitVersion: 1 }).where(eq(bankConnections.id, c.id));
    await sync(c);
    const current = await getEntry(h.db, f.ownerId, entry.id);
    expect(current).toMatchObject({ status: "confirmed", benefitCredit: true, benefitFamily: family });
    expect(current.postings.find((line) => line.categoryId)?.categoryId).toBe(f.category(category));
    expect(BENEFIT_VERSION).toBe(4);
    expect(
      (await h.db.select().from(bankConnections).where(eq(bankConnections.id, c.id)))[0].benefitVersion,
    ).toBe(BENEFIT_VERSION);
    const audits = await h.db.select().from(auditLogs).where(eq(auditLogs.entityId, entry.id));
    await sync(c);
    expect(await h.db.select().from(journalEntries)).toHaveLength(1);
    expect(await h.db.select().from(auditLogs).where(eq(auditLogs.entityId, entry.id))).toEqual(audits);
  },
);

it("records a Platinum wireless credit without linking the carrier bill and shows its family", async () => {
  f.card = await createAccount(h.db, f.ownerId, {
    name: "Demo Amex Platinum 1234",
    type: "liability_credit_card",
    currency: "USD",
  });
  const c = await connect();
  await sync(c, [
    tx(c, "wireless-credit", "-10", "Platinum Wireless Credit", { primary: "TRANSFER_IN" }),
    tx(c, "wireless-bill", "40", "AT&T WIRELESS", {
      primary: "RENT_AND_UTILITIES",
      detailed: "RENT_AND_UTILITIES_TELEPHONE",
      date: "2026-10-12",
    }),
  ]);
  const bill = await entryFor("wireless-bill");
  const credit = await entryFor("wireless-credit");
  expect(credit).toMatchObject({
    entryType: "refund",
    benefitCredit: true,
    benefitFamily: "wireless",
    refundOfEntryId: null,
    transferMatchId: null,
  });
  expect(bill.benefitCredit).toBe(false);
  expect(bill.postings.find((line) => line.categoryId)?.categoryId).toBe(f.category("水电网络"));
  expect(credit.postings.find((line) => line.categoryId)?.categoryId).toBe(f.category("水电网络"));
  expect(await balance(f.expense.id)).toBe("30.0000");
  expect(await balance(f.income.id)).toBe("0.0000");
  expect((await pendingWorkbench(h.db, f.ownerId, "sandbox")).count).toBe(0);
  const data = await benefitOverview(h.db, f.ownerId, "2026-10-24");
  expect(data.cards.find((card) => card.accountId === f.card.id)!.families[0]).toMatchObject({
    family: "wireless",
    annual: "10.0000",
    rolling: "10.0000",
  });
  expect(
    renderToStaticMarkup(
      <BenefitEditor entryId={credit.id} enabled isRefund initialFamily="wireless" onSaved={() => {}} />,
    ),
  ).toContain('value="wireless"');
});
it.each(["其他支出", "住房租金"])(
  "uses the family category without linking when the bill category is %s",
  async (category) => {
    const bill = await expense("40", category, "AT T WIRELESS");
    await expense("35", "其他支出", "at target");
    const credit = await benefit("10", "wireless");
    expect(credit.refundOfEntryId).toBeNull();
    expect(credit.postings.find((line) => line.categoryId)?.categoryId).toBe(f.category("水电网络"));
    expect(
      (await getEntry(h.db, f.ownerId, bill.id)).postings.find((line) => line.categoryId)?.categoryId,
    ).toBe(f.category(category));
  },
);

it("auto-posts keyword credits as benefits and keeps RETURN CREDIT as an ordinary refund", async () => {
  const c = await connect();
  await sync(c, [
    tx(c, "uber-one-credit", "-15", "AMEX UBER ONE CREDIT"),
    tx(c, "merchant-return", "-9", "RETURN CREDIT AMAZON"),
  ]);
  const credit = await entryFor("uber-one-credit");
  expect(credit).toMatchObject({
    entryType: "refund",
    benefitCredit: true,
    benefitFamily: "generic",
    refundOfEntryId: null,
    transferMatchId: null,
  });
  expect(await entryFor("merchant-return")).toMatchObject({
    entryType: "refund",
    benefitCredit: false,
    benefitFamily: null,
  });
  const card = (await benefitOverview(h.db, f.ownerId, "2026-10-24")).cards[0];
  expect(card.annual).toBe("15.0000");
  expect(card.byName).toMatchObject([
    { name: "Uber One Credit", count: 1, total: "15.0000", lastDate: "2026-10-22" },
  ]);
  expect(await balance(f.expense.id)).toBe("-24.0000");
  expect(await balance(f.income.id)).toBe("0.0000");
});

it("current version rescans keyword refunds once, preserving edited/matched entries and the 365-day boundary", async () => {
  const c = await connect(f.card.id, false);
  const specimens = [
    { id: "untouched-keyword", name: "AMEX UBER ONE CREDIT", date: "2026-10-22" },
    { id: "edited-keyword", name: "OURA CREDIT", date: "2026-10-22" },
    { id: "old-keyword", name: "PLATINUM LULULEMON CREDIT", date: "2025-10-23" },
    { id: "boundary-keyword", name: "AMEX BENEFIT CREDIT", date: "2025-10-24" },
    { id: "payment-classified", name: "ONLINE CREDIT", date: "2026-10-22" },
  ];
  await sync(
    c,
    specimens.map((specimen) =>
      tx(c, specimen.id, "-12", specimen.name, {
        primary: specimen.id === "payment-classified" ? "LOAN_PAYMENTS" : null,
      }),
    ),
  );
  const rows = await h.db.select().from(importRows).where(eq(importRows.ownerId, f.ownerId));
  const entryIds: Record<string, string> = {};
  for (const specimen of specimens) {
    const entry = await createQuickEntry(h.db, f.ownerId, {
      type: "refund",
      amount: "12",
      toAccountId: f.card.id,
      categoryId: f.category("其他支出"),
      eventDate: specimen.date,
      description: specimen.name,
    });
    entryIds[specimen.id] = entry.id;
    await stampAutoEntry(h.db, f.ownerId, entry.id);
    await h.db
      .update(importRows)
      .set({ journalEntryId: entry.id, autoPostState: "posted", decision: "approve" })
      .where(eq(importRows.id, rows.find((row) => row.providerTransactionId === specimen.id)!.id));
  }
  await updateEntryMeta(h.db, f.ownerId, entryIds["edited-keyword"], { notes: "Owner checked" });
  const matched = await oldClearing(c, "AMEX UBER ONE CREDIT", "matched-keyword");
  const bank = await createEntry(
    h.db,
    f.ownerId,
    await clearingInput(h.db, f.ownerId, {
      accountId: f.bank.id,
      amount: "-30",
      currency: "USD",
      transactionDate: "2026-10-22",
      postedDate: "2026-10-22",
      descriptionRaw: "BANK TRANSFER",
      merchantNormalized: "bank transfer",
    }),
  );
  await resolveEntryMatching(h.db, f.ownerId, matched.id, { action: "match", counterpartEntryId: bank.id });
  await h.db
    .update(journalEntries)
    .set({ autoPostOwnerEdited: false })
    .where(eq(journalEntries.id, matched.id));
  await stampAutoEntry(h.db, f.ownerId, matched.id);
  const protectedEntries = await Promise.all(
    [entryIds["edited-keyword"], entryIds["old-keyword"], entryIds["payment-classified"], matched.id].map(
      (id) => getEntry(h.db, f.ownerId, id),
    ),
  );
  await setAutoPost(h.db, f.ownerId, c.id, config, { autoPost: true });
  await h.db.update(bankConnections).set({ benefitVersion: 2 }).where(eq(bankConnections.id, c.id));
  await sync(c);
  expect(BENEFIT_VERSION).toBe(4);
  for (const id of [entryIds["untouched-keyword"], entryIds["boundary-keyword"]])
    expect(await getEntry(h.db, f.ownerId, id)).toMatchObject({
      status: "confirmed",
      entryType: "refund",
      benefitCredit: true,
      benefitFamily: "generic",
    });
  for (const entry of protectedEntries) expect(await getEntry(h.db, f.ownerId, entry.id)).toEqual(entry);
  expect(
    (await h.db.select().from(bankConnections).where(eq(bankConnections.id, c.id)))[0].benefitVersion,
  ).toBe(4);
  const entries = await h.db.select().from(journalEntries);
  const audits = await h.db.select().from(auditLogs).where(eq(auditLogs.entityType, "journal_entry"));
  await sync(c);
  expect(await h.db.select().from(journalEntries)).toEqual(entries);
  expect(await h.db.select().from(auditLogs).where(eq(auditLogs.entityType, "journal_entry"))).toEqual(
    audits,
  );
});

it.each(["pdf", "csv"])(
  "%s approval uses keyword detection and allows benefits without a purchase link",
  async (kind) => {
    const [statement] = await h.db
      .insert(statements)
      .values({
        ownerId: f.ownerId,
        accountId: f.card.id,
        fileSha256: "b".repeat(64),
        originalFilename: `synthetic-keywords.${kind}`,
        mime: kind === "pdf" ? "application/pdf" : "text/csv",
        sizeBytes: 100,
      })
      .returning();
    const parsed = parseCsv(
      new TextEncoder().encode(
        "Date,Receipt,Description,Amount\n10/22/2026,,AMEX UBER ONE CREDIT,-15.00\n10/22/2026,,RETURN CREDIT AMAZON,-9.00\n",
      ),
      amexMapping,
      f.card,
    );
    await applyParsedStatement(h.db, f.ownerId, statement.id, {
      statement_type: "credit_card",
      currency: "USD",
      page_count: 1,
      parser_version: "1",
      summary: {},
      diagnostics: [],
      transaction_lines: [],
      parser: kind === "pdf" ? "synthetic-pdf" : "csv",
      entries: parsed.entries.map((row) => ({
        ...row,
        direction: kind === "pdf" ? "credit" : row.direction,
      })),
    });
    const rows = await statementRows(h.db, f.ownerId, statement.id);
    const credit = rows.find((row) => row.descriptionRaw === "AMEX UBER ONE CREDIT")!;
    const returned = rows.find((row) => row.descriptionRaw === "RETURN CREDIT AMAZON")!;
    expect(credit).toMatchObject({ suggestedEntryType: "refund", journalEntryId: null });
    expect(credit.softNotes.join(" ")).toContain("权益报销建议");
    expect(returned.softNotes.join(" ")).not.toContain("权益报销建议");
    for (const row of rows)
      await updateImportRows(h.db, f.ownerId, statement.id, {
        rowIds: [row.id],
        changes: { decision: "approve", suggestedCategoryId: f.category("其他支出") },
      });
    const result = await approveRows(h.db, f.ownerId, statement.id, {
      rowIds: rows.map((row) => row.id),
      idempotencyKey: "synthetic-keyword-approval",
    });
    expect(
      await getEntry(h.db, f.ownerId, result.find((row) => row.rowId === credit.id)!.entryId),
    ).toMatchObject({
      entryType: "refund",
      source: "import",
      benefitCredit: true,
      benefitFamily: "generic",
      refundOfEntryId: null,
    });
    expect(
      await getEntry(h.db, f.ownerId, result.find((row) => row.rowId === returned.id)!.entryId),
    ).toMatchObject({ entryType: "refund", benefitCredit: false });
    expect((await benefitOverview(h.db, f.ownerId, "2026-10-24")).cards[0].annual).toBe("15.0000");
  },
);

async function namedBenefit(
  amount: string,
  date: string,
  description: string | null,
  options: { postedDate?: string; merchant?: string; status?: "draft" | "confirmed" } = {},
) {
  const entry = await benefitInput(h.db, f.ownerId, {
    accountId: f.card.id,
    amount,
    currency: "USD",
    eventDate: date,
    description,
    family: "generic",
    postedDate: options.postedDate,
    merchant: options.merchant,
  });
  return createEntry(h.db, f.ownerId, { ...entry, status: options.status ?? "confirmed" });
}
it("groups yearly credit names across dates/reference numbers, sorts decimal totals and retains entry links", async () => {
  const first = await namedBenefit(
    "20.005",
    "2026-01-25",
    "PLATINUM DIGITAL ENTERTAINMENT CREDIT 01/25/2026 REF#AB123 CARD 1234",
  );
  const second = await namedBenefit(
    "20.005",
    "2026-02-25",
    "platinum digital entertainment credit Feb 25, 2026 reference XY456 card ending in 9876",
  );
  const third = await namedBenefit(
    "20.005",
    "2025-12-31",
    "PLATINUM DIGITAL ENTERTAINMENT CREDIT 2026-03-25 #ZX789",
    { postedDate: "2026-03-25" },
  );
  await namedBenefit("100", "2026-04-01", null, { merchant: "OURA CREDIT" });
  await namedBenefit("9", "2025-10-25", "PLATINUM DIGITAL ENTERTAINMENT CREDIT 10/25/2025 REF ABC123");
  await namedBenefit("70", "2026-12-01", "PLATINUM DIGITAL ENTERTAINMENT CREDIT 12/01/2026");
  await namedBenefit("80", "2026-05-01", "PLATINUM DIGITAL ENTERTAINMENT CREDIT", { status: "draft" });
  const data = await benefitOverview(h.db, f.ownerId, "2026-10-24");
  expect(data.cards[0]).toMatchObject({
    annual: "160.0150",
    rolling: "169.0150",
    byName: [
      { name: "Oura Credit", count: 1, total: "100.0000", lastDate: "2026-04-01" },
      { name: "Digital Entertainment Credit", count: 3, total: "60.0150", lastDate: "2026-03-25" },
    ],
  });
  const historical = await benefitOverview(h.db, f.ownerId, "2026-10-24", "2025");
  expect(historical.cards[0].byName).toMatchObject([
    { name: "Digital Entertainment Credit", count: 1, total: "9.0000", lastDate: "2025-10-25" },
  ]);
  const html = renderToStaticMarkup(<BenefitDetails card={data.cards[0]} year={data.year} />);
  expect(html).toContain("2026 年合计");
  expect(html).toContain("3 次");
  expect(html).toContain("60.02");
  expect(html.indexOf("Oura Credit")).toBeLessThan(html.indexOf("Digital Entertainment Credit"));
  expect(html).toContain("按权益类型汇总");
  expect(data.cards[0].byName[1].entries.map((entry) => entry.id)).toEqual([third.id, second.id, first.id]);
  expect(html).toContain(`/activity?accountId=${f.card.id}`);
  expect(html).not.toMatch(/<details[^>]*\bopen/);
  for (const entry of [first, second, third]) expect(html).toContain(`/activity?entryId=${entry.id}`);
  expect(
    renderToStaticMarkup(<BenefitDetails card={historical.cards[0]} year={historical.year} />),
  ).toContain("2025 年合计");
});

it("GET benefits returns the page summary, defaults to the owner's local year, and isolates owners", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-01T02:30:00Z"));
  try {
    await h.db.update(users).set({ timezone: "America/Los_Angeles" }).where(eq(users.id, f.ownerId));
    const old = await namedBenefit("9", "2025-10-25", "AMEX BENEFIT CREDIT");
    const recent = await namedBenefit("15", "2026-12-31", "AMEX UBER ONE CREDIT REF ZX123");
    const next = await namedBenefit("12", "2027-01-01", "OURA CREDIT");
    const url = "http://localhost:3000/api/benefits";
    expect((await overviewRoute.GET(new NextRequest(url))).status).toBe(401);
    const own = await createSession(h.db, f.ownerId, { ipHash: "test", userAgent: "synthetic" });
    const foreign = await createSession(h.db, f.otherId, { ipHash: "test", userAgent: "synthetic" });
    const headers = { cookie: `al_session=${own.token}` };
    const response = await overviewRoute.GET(new NextRequest(url, { headers }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const data = await response.json();
    expect(data).toEqual(await benefitOverview(h.db, f.ownerId, "2026-12-31"));
    expect(data).toMatchObject({ asOf: "2026-12-31", year: "2026" });
    expect(Object.keys(data.cards[0]).sort()).toEqual(
      [
        "accountId",
        "name",
        "currency",
        "institution",
        "last4",
        "annual",
        "rolling",
        "byName",
        "families",
      ].sort(),
    );
    expect(data.cards[0].byName).toMatchObject([
      { name: "Uber One Credit", count: 1, total: "15.0000", lastDate: "2026-12-31" },
    ]);
    expect(Object.keys(data.cards[0].families[0].entries[0]).sort()).toEqual(
      ["id", "date", "description", "amount"].sort(),
    );
    expect(data.cards[0].families[0].entries.map((entry: { id: string }) => entry.id)).toEqual([recent.id]);
    const history = await (await overviewRoute.GET(new NextRequest(`${url}?year=2025`, { headers }))).json();
    expect(history.cards[0].annual).toBe("9.0000");
    expect(history.cards[0].families[0].entries.map((entry: { id: string }) => entry.id)).toContain(old.id);
    const other = await (
      await overviewRoute.GET(
        new NextRequest(`${url}?ownerId=${f.ownerId}`, {
          headers: { cookie: `al_session=${foreign.token}` },
        }),
      )
    ).json();
    expect(other.cards).toEqual([]);
    for (const year of ["26", "2026-01", "2026abc", ""])
      expect((await overviewRoute.GET(new NextRequest(`${url}?year=${year}`, { headers }))).status).toBe(400);
    await h.db.update(users).set({ timezone: "Asia/Shanghai" }).where(eq(users.id, f.ownerId));
    const east = await (await overviewRoute.GET(new NextRequest(url, { headers }))).json();
    expect(east).toMatchObject({ asOf: "2027-01-01", year: "2027" });
    expect(east.cards[0].byName).toMatchObject([
      { name: "Oura Credit", count: 1, total: "12.0000", lastDate: "2027-01-01" },
    ]);
    expect(east.cards[0].families[0].entries.map((entry: { id: string }) => entry.id)).toContain(next.id);
  } finally {
    vi.useRealTimers();
  }
});

it("preserves PFC payment evidence through suggestions and explicit refund approval", async () => {
  const c = await connect(f.card.id, false);
  await sync(c, [tx(c, "review-payment", "-15", "ONLINE CREDIT", { primary: "LOAN_PAYMENTS" })]);
  const [row] = await h.db.select().from(importRows).where(eq(importRows.ownerId, f.ownerId));
  expect(row.suggestedEntryType).toBe("credit_card_payment");
  expect(row.softNotes.join(" ")).not.toContain("权益报销建议");
  await updateImportRows(h.db, f.ownerId, row.statementId, {
    rowIds: [row.id],
    changes: {
      decision: "approve",
      suggestedEntryType: "refund",
      suggestedCategoryId: f.category("其他支出"),
    },
  });
  const result = await approveRows(h.db, f.ownerId, row.statementId, {
    rowIds: [row.id],
    idempotencyKey: "synthetic-pfc-refund-approval",
  });
  expect(await getEntry(h.db, f.ownerId, result[0].entryId)).toMatchObject({
    entryType: "refund",
    benefitCredit: false,
    benefitFamily: null,
  });
});

it("shows active credit cards with no credits, excludes other owners, and orders category fallbacks", async () => {
  const data = await benefitOverview(h.db, f.ownerId, "2026-10-24");
  expect(data.cards).toMatchObject([
    { accountId: f.card.id, annual: "0.0000", rolling: "0.0000", byName: [] },
  ]);
  expect((await benefit("12", "entertainment")).postings.find((line) => line.categoryId)?.categoryId).toBe(
    f.category("娱乐"),
  );
  await h.db
    .update(categories)
    .set({ isArchived: true })
    .where(eq(categories.id, f.category("娱乐")));
  expect((await benefit("12", "entertainment")).postings.find((line) => line.categoryId)?.categoryId).toBe(
    f.category("订阅服务"),
  );
  await h.db
    .update(categories)
    .set({ isArchived: true })
    .where(eq(categories.id, f.category("订阅服务")));
  expect((await benefit("12", "entertainment")).postings.find((line) => line.categoryId)?.categoryId).toBe(
    f.category("其他支出"),
  );
  const empty = await createAccount(h.db, f.ownerId, {
    name: "Inactive synthetic card",
    type: "liability_credit_card",
    currency: "USD",
  });
  await h.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, empty.id));
  expect(
    (await benefitOverview(h.db, f.ownerId, "2026-10-24")).cards.some((card) => card.accountId === empty.id),
  ).toBe(false);
});

it("unflags untouched historical auto offers once with a metadata audit, preserves edits/upstream and excludes all offers from totals", async () => {
  const c = await connect();
  await sync(c, [
    tx(c, "offer-old", "-21", "AMEX OFFERS CREDIT"),
    tx(c, "offer-edited", "-22", "MERCHANT OFFER CREDIT"),
    tx(c, "offer-upstream", "-23", "CASHBACK OFFER"),
    tx(c, "offer-generic", "-24", "WIRELESS OFFER CREDIT"),
  ]);
  for (const id of ["offer-old", "offer-edited", "offer-upstream", "offer-generic"]) {
    const entry = await entryFor(id);
    expect(entry).toMatchObject({ entryType: "refund", benefitCredit: false, benefitFamily: null });
    await h.db
      .update(journalEntries)
      .set({
        benefitCredit: true,
        benefitFamily: id === "offer-generic" ? "generic" : "offer",
        ...(id === "offer-old" ? { eventDate: "2024-01-01", postedDate: "2024-01-01" } : {}),
      })
      .where(eq(journalEntries.id, entry.id));
    await stampAutoEntry(h.db, f.ownerId, entry.id);
  }
  const edited = await entryFor("offer-edited");
  await updateEntryMeta(h.db, f.ownerId, edited.id, { notes: "Owner reviewed" });
  await h.db
    .update(importRows)
    .set({ upstreamState: "modified", autoPostState: "upstream", upstreamPayload: {} })
    .where(eq(importRows.providerTransactionId, "offer-upstream"));
  await h.db.update(bankConnections).set({ benefitVersion: 3 }).where(eq(bankConnections.id, c.id));
  const before = await entryFor("offer-old");
  await sync(c);
  const after = await entryFor("offer-old");
  expect(after).toMatchObject({
    id: before.id,
    status: "confirmed",
    benefitCredit: false,
    benefitFamily: null,
    autoPostOwnerEdited: false,
  });
  expect(after.postings).toEqual(before.postings);
  expect(untouched(after)).toBe(true);
  expect(await entryFor("offer-generic")).toMatchObject({ benefitCredit: false, benefitFamily: null });
  expect(await entryFor("offer-edited")).toMatchObject({ benefitCredit: true, benefitFamily: "offer" });
  expect(await entryFor("offer-upstream")).toMatchObject({ benefitCredit: true, benefitFamily: "offer" });
  const audits = await h.db.select().from(auditLogs).where(eq(auditLogs.action, "benefit.unmark"));
  expect(audits).toHaveLength(2);
  expect(audits.every((row) => JSON.stringify(row.changes) === "{}")).toBe(true);
  const data = await benefitOverview(h.db, f.ownerId, "2026-10-24");
  expect(data.cards[0]).toMatchObject({ annual: "0.0000", rolling: "0.0000", byName: [], families: [] });
  const repeatBefore = await h.db.select().from(journalEntries);
  await sync(c);
  expect(await h.db.select().from(journalEntries)).toEqual(repeatBefore);
  expect(await h.db.select().from(auditLogs).where(eq(auditLogs.action, "benefit.unmark"))).toHaveLength(2);
});
it("omits voided benefits and the legacy offer editor choice", async () => {
  const entry = await namedBenefit("11", "2026-10-10", "AMEX CHATGPT CREDIT");
  await voidEntry(h.db, f.ownerId, entry.id, "Synthetic void");
  await benefit("14", "offer");
  const data = await benefitOverview(h.db, f.ownerId, "2026-10-24");
  expect(data.cards[0]).toMatchObject({ annual: "0.0000", rolling: "0.0000", byName: [], families: [] });
  const html = renderToStaticMarkup(
    <BenefitEditor entryId={entry.id} enabled isRefund initialFamily="offer" onSaved={() => {}} />,
  );
  expect(html).not.toContain('value="offer"');
  expect(html).not.toContain("商户优惠");
});

it.each(["description", "merchant"] as const)(
  "excludes owner-edited generic offers identified by %s without changing metadata",
  async (field) => {
    const entry = await namedBenefit(
      "13",
      "2026-10-12",
      field === "description" ? "AMEX MERCHANT OFFER CREDIT" : "GENERIC CREDIT",
      field === "merchant" ? { merchant: "AMEX OFFERS" } : {},
    );
    await stampAutoEntry(h.db, f.ownerId, entry.id);
    await updateEntryMeta(h.db, f.ownerId, entry.id, { notes: "Owner reviewed category" });
    const before = await getEntry(h.db, f.ownerId, entry.id);
    expect(before).toMatchObject({
      benefitCredit: true,
      benefitFamily: "generic",
      autoPostOwnerEdited: true,
    });
    const data = await benefitOverview(h.db, f.ownerId, "2026-10-24");
    expect(data.cards[0]).toMatchObject({ annual: "0.0000", rolling: "0.0000", byName: [], families: [] });
    expect(await getEntry(h.db, f.ownerId, entry.id)).toEqual(before);
  },
);
