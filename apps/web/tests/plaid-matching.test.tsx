import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { bankAccount, bankTransaction, FakePlaid, plaidConfig as config } from "./helpers/plaid";
import type { BankTransaction } from "@/lib/bank-sync/types";
import {
  bankConnections,
  bankConnectionAccounts,
  auditLogs,
  importRows,
  journalEntries,
  postings,
} from "@/db/schema";
import { exchangeConnection, saveMapping } from "@/lib/bank-sync/connections";
import { syncConnection } from "@/lib/bank-sync/sync";
import { executeBackfill } from "@/lib/bank-sync/backfill";
import { pendingWorkbench, setAutoPost } from "@/lib/bank-sync/pending";
import { entryMatching, resolveEntryMatching } from "@/lib/bank-sync/matching";
import {
  accountAliases,
  counterpartyHint,
  dateDistance,
  signalStrength,
  strongestCandidates,
  type SignalLeg,
} from "@/lib/bank-sync/match-signals";
import { fallbackInput } from "@/lib/bank-sync/transfer-fallback";
import { isTransferLike } from "@/lib/bank-sync/transfer-config";
import { classifyTransaction } from "@/lib/bank-sync/classification";
import { clearingInput } from "@/lib/bank-sync/transfer-legs";
import { ActivityView } from "@/components/ledger/activity-view";
import { stampAutoEntry } from "@/lib/bank-sync/auto-state";
import { createAccount, listAccounts, updateAccount } from "@/lib/ledger/accounts";
import { buildPostings } from "@/lib/ledger/builders";
import { createEntry, getEntry, replaceEntry, updateEntryMeta, voidEntry } from "@/lib/ledger/entries";
import { accountBalance, listEntries } from "@/lib/ledger/queries";
import { createSession } from "@/lib/auth/session";
import { EntryDetailView } from "@/components/ledger/entry-detail";
import { PendingView } from "@/components/bank-sync/pending-view";
import { jsonSafe } from "@/lib/serialization";

let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
const now = new Date("2026-10-24T12:00:00Z");
vi.mock("@/db/client", () => ({ getDb: () => h.db }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const matchingRoute = await import("@/app/api/transactions/[id]/matching/route");
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
async function connect(
  accountId: string,
  type: string,
  institution = "Example Bank",
  from = "2026-10-01",
  autoPost = true,
) {
  const client = new FakePlaid();
  client.item.id = `item-${accountId}`;
  client.item.institutionName = institution;
  client.accountRows = [
    {
      ...bankAccount(accountId, type),
      mask:
        (await listAccounts(h.db, f.ownerId)).find((row) => row.id === accountId)?.last4?.slice(-4) ??
        (accountId === f.card.id ? "1234" : "9876"),
    },
  ];
  const linked = await exchangeConnection(
    h.db,
    f.ownerId,
    client,
    config,
    {
      public_token: "synthetic-public",
      institution: { institution_id: `ins_${accountId}`, name: institution },
    },
    now,
  );
  await saveMapping(
    h.db,
    f.ownerId,
    linked.connection.id,
    config,
    {
      importFromDate: from,
      accounts: [{ id: linked.accounts[0].id, accountId }],
    },
    now,
  );
  if (!autoPost) await setAutoPost(h.db, f.ownerId, linked.connection.id, config, { autoPost });
  return { id: linked.connection.id, accountId, client };
}
type Connection = Awaited<ReturnType<typeof connect>>;
function tx(c: Connection, id: string, amount: string, name: string, extra: Partial<BankTransaction> = {}) {
  return bankTransaction(id, {
    accountId: c.accountId,
    amount,
    name,
    merchantName: null,
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
const entries = () => h.db.select().from(journalEntries).where(eq(journalEntries.ownerId, f.ownerId));
const rows = () => h.db.select().from(importRows).where(eq(importRows.ownerId, f.ownerId));
const balance = (id: string) => accountBalance(h.db, f.ownerId, id, "2026-10-31");
async function expectMatched(type: string) {
  const current = (await entries()).filter((entry) => entry.status === "confirmed");
  expect(current).toHaveLength(2);
  expect(current.every((entry) => entry.entryType === type && entry.transferMatchId)).toBe(true);
  expect(new Set(current.map((entry) => entry.transferMatchId)).size).toBe(1);
  expect(await balance(f.expense.id)).toBe("0.0000");
  expect(await balance(f.income.id)).toBe("0.0000");
  expect((await pendingWorkbench(h.db, f.ownerId, "sandbox")).count).toBe(0);
  return current;
}

it.each([
  ["CAPITAL ONE MOBILE PMT", "CAPITAL ONE AUTOPAY PYMT", "Capital One"],
  ["Bill Payment to Citi", "PAYMENT THANK YOU", "Citi"],
])("matches %s against %s with no PFC and preserves each bank date", async (out, incoming, institution) => {
  const bank = await connect(f.bank.id, "depository");
  const card = await connect(f.card.id, "credit", institution);
  await sync(bank, [tx(bank, "out", "120", out, { date: "2026-10-18", authorizedDate: "2026-10-18" })]);
  await sync(card, [tx(card, "in", "-120", incoming)]);
  const pair = await expectMatched("credit_card_payment");
  expect(pair.map((entry) => entry.postedDate).sort()).toEqual(["2026-10-18", "2026-10-22"]);
  expect(await balance(f.bank.id)).toBe("-120.0000");
  expect(await balance(f.card.id)).toBe("120.0000");
});
it("uses the closest authorized/posted dates rather than only posted dates", async () => {
  const bank = await connect(f.bank.id, "depository");
  const card = await connect(f.card.id, "credit");
  await sync(bank, [tx(bank, "out", "40", "ACH PMT", { date: "2026-10-12", authorizedDate: "2026-10-11" })]);
  await sync(card, [
    tx(card, "in", "-40", "PAYMENT THANK YOU", { date: "2026-10-22", authorizedDate: "2026-10-14" }),
  ]);
  await expectMatched("credit_card_payment");
});
it("converts X Money card funding from expense to transfer using institution and standalone mask hints", async () => {
  const card = await connect(f.card.id, "credit", "Citi");
  const wallet = await connect(f.bank.id, "depository", "X Money");
  await sync(card, [tx(card, "charge", "50", "X MONEY")]);
  const old = (await entries())[0];
  expect(old.entryType).toBe("expense");
  await sync(wallet, [tx(wallet, "funding", "-50", "Funded from card 1234")]);
  const pair = await expectMatched("transfer");
  expect(pair.some((entry) => entry.replacesEntryId === old.id)).toBe(true);
  expect(await balance(f.card.id)).toBe("-50.0000");
  expect(await balance(f.bank.id)).toBe("50.0000");
  expect((await getEntry(h.db, f.ownerId, old.id)).status).toBe("voided");
  const before = await entries();
  await sync(wallet);
  expect(await entries()).toEqual(before);
});
it("never matches a grocery charge with unrelated equal Zelle income", async () => {
  const card = await connect(f.card.id, "credit", "Citi");
  const bank = await connect(f.bank.id, "depository");
  await sync(card, [tx(card, "grocery", "50", "SYNTHETIC GROCER")]);
  await sync(bank, [tx(bank, "gift", "-50", "Zelle from Alex Sample")]);
  expect((await entries()).map((entry) => entry.entryType).sort()).toEqual(["expense", "income"]);
  expect((await entries()).every((entry) => !entry.transferMatchId)).toBe(true);
  expect((await pendingWorkbench(h.db, f.ownerId, "sandbox")).suggestions).toHaveLength(1);
  expect((await pendingWorkbench(h.db, f.ownerId, "sandbox")).count).toBe(1);
  const detail = await entryMatching(h.db, f.ownerId, (await entries())[0].id);
  expect(detail.diagnostics.join()).toContain("缺少足够转账信号");
});
it("leaves equal-signal candidates unmatched, lists both, and counts an edited candidate", async () => {
  const bank = await connect(f.bank.id, "depository");
  const card = await connect(f.card.id, "credit", "Capital One");
  await sync(card, [tx(card, "in-a", "-85", "AUTOPAY PYMT"), tx(card, "in-b", "-85", "PAYMENT THANK YOU")]);
  await updateEntryMeta(h.db, f.ownerId, (await entries())[0].id, { notes: "Owner checked" });
  await sync(bank, [tx(bank, "out", "85", "CAPITAL ONE MOBILE PMT")]);
  const data = await pendingWorkbench(h.db, f.ownerId, "sandbox");
  expect(data.transfers).toHaveLength(0);
  expect(data.suggestions).toHaveLength(2);
  const debit = await entryMatching(
    h.db,
    f.ownerId,
    (await rows()).find((row) => row.accountId === f.bank.id)!.journalEntryId!,
  );
  expect(debit.candidates).toHaveLength(2);
  expect(debit.diagnostics.join()).toContain("多个同等信号候选");
  expect(debit.diagnostics.join()).toContain("所有者编辑");
  expect((await entries()).every((entry) => !entry.transferMatchId)).toBe(true);
});
async function legacyPost(rowId: string, type: "expense" | "refund" | "income") {
  const row = (await rows()).find((row) => row.id === rowId)!;
  const positive = row.amount.startsWith("-") === false;
  const input = await buildPostings(h.db, f.ownerId, type, {
    amount: row.amount.replace("-", ""),
    fromAccountId: positive ? null : row.accountId,
    toAccountId: positive ? row.accountId : null,
    categoryId: f.category(type === "income" ? "其他收入" : "其他支出"),
    eventDate: row.transactionDate!,
    postedDate: row.postedDate,
    merchant: row.merchantNormalized,
    description: row.descriptionRaw,
    status: "confirmed",
  });
  const entry = await createEntry(h.db, f.ownerId, { ...input, source: "import" });
  await h.db
    .update(journalEntries)
    .set({ providerAccountId: row.accountId, providerTransactionId: row.providerTransactionId })
    .where(eq(journalEntries.id, entry.id));
  await stampAutoEntry(h.db, f.ownerId, entry.id);
  await h.db
    .update(importRows)
    .set({ journalEntryId: entry.id, autoPostState: "posted", decision: "approve" })
    .where(eq(importRows.id, rowId));
  return entry;
}
it.each([false, true])("re-scans old expense/refund classifications, owner-edited=%s", async (edited) => {
  const bank = await connect(f.bank.id, "depository", "Example Bank", "2026-10-01", false);
  const card = await connect(f.card.id, "credit", "Capital One", "2026-10-01", false);
  await sync(bank, [tx(bank, "out", "75", "CAPITAL ONE MOBILE PMT")]);
  await sync(card, [tx(card, "in", "-75", "CAPITAL ONE AUTOPAY PYMT")]);
  const originals = [];
  for (const row of await rows())
    originals.push(await legacyPost(row.id, row.accountId === f.bank.id ? "expense" : "refund"));
  if (edited) await updateEntryMeta(h.db, f.ownerId, originals[0].id, { notes: "Keep owner choice" });
  for (const c of [bank, card]) await setAutoPost(h.db, f.ownerId, c.id, config, { autoPost: true });
  await sync(bank);
  if (edited) {
    expect(await entries()).toHaveLength(2);
    expect((await entries()).every((entry) => !entry.transferMatchId)).toBe(true);
  } else {
    await expectMatched("credit_card_payment");
    expect((await entries()).filter((entry) => entry.status === "voided")).toHaveLength(2);
    const audit = await h.db.select().from(auditLogs).where(eq(auditLogs.action, "auto_rematched_transfer"));
    expect(audit).toHaveLength(2);
  }
  const before = await entries();
  const lines = await h.db.select().from(postings);
  await sync(card);
  expect(await entries()).toEqual(before);
  expect(await h.db.select().from(postings)).toEqual(lines);
});
it("backfill restores a skipped counterpart and re-matches idempotently", async () => {
  const bank = await connect(f.bank.id, "depository", "Example Bank", "2026-10-24");
  const card = await connect(f.card.id, "credit", "Capital One");
  const outgoing = tx(bank, "historical-out", "90", "CAPITAL ONE MOBILE PMT");
  await sync(bank, [outgoing]);
  expect(await rows()).toHaveLength(0);
  await sync(card, [tx(card, "in", "-90", "AUTOPAY PYMT")]);
  await executeBackfill(h.db, f.ownerId, bank.id, config, { from: "2026-10-01" }, now);
  await sync(bank, [outgoing]);
  await expectMatched("credit_card_payment");
  const before = await entries();
  await executeBackfill(h.db, f.ownerId, bank.id, config, { from: "2026-10-01" }, now);
  await sync(bank, [outgoing]);
  expect(await entries()).toEqual(before);
  expect(await rows()).toHaveLength(2);
});
async function manualPair() {
  const debit = await createEntry(
    h.db,
    f.ownerId,
    await buildPostings(h.db, f.ownerId, "expense", {
      amount: "65",
      fromAccountId: f.bank.id,
      categoryId: f.category("其他支出"),
      eventDate: "2026-10-15",
      merchant: "Owner label",
      status: "confirmed",
    }),
  );
  const credit = await createEntry(h.db, f.ownerId, {
    ...(await buildPostings(h.db, f.ownerId, "refund", {
      amount: "65",
      toAccountId: f.card.id,
      categoryId: f.category("购物"),
      eventDate: "2026-10-22",
      merchant: "PDF credit",
      status: "confirmed",
    })),
    source: "import",
  });
  return { debit, credit };
}
it("manual matching from activity allows edited/manual/PDF entries within seven days; unmatch restores income/expense", async () => {
  const bank = await connect(f.bank.id, "depository");
  await connect(f.card.id, "credit");
  const { debit, credit } = await manualPair();
  await updateEntryMeta(h.db, f.ownerId, debit.id, { notes: "Human-reviewed payment" });
  const choices = await entryMatching(h.db, f.ownerId, debit.id);
  expect(choices.candidates.map((entry) => entry.id)).toEqual([credit.id]);
  const result = await resolveEntryMatching(h.db, f.ownerId, debit.id, {
    action: "match",
    counterpartEntryId: credit.id,
  });
  const matched = (await entries()).filter((entry) => entry.transferMatchId === result.transferMatchId);
  expect(matched).toHaveLength(2);
  expect(
    matched.every((entry) => entry.autoPostOwnerEdited && entry.entryType === "credit_card_payment"),
  ).toBe(true);
  expect(matched.map((entry) => entry.source).sort()).toEqual(["import", "manual"]);
  expect((await getEntry(h.db, f.ownerId, debit.id)).status).toBe("voided");
  await resolveEntryMatching(h.db, f.ownerId, matched[0].id, { action: "unmatch" });
  const pending = await pendingWorkbench(h.db, f.ownerId, "sandbox");
  expect(pending.transfers).toHaveLength(0);
  expect(
    (await entries())
      .filter((entry) => entry.status === "confirmed")
      .map((entry) => entry.entryType)
      .sort(),
  ).toEqual(["expense", "income"]);
  const before = await entries();
  await sync(bank);
  expect(await entries()).toEqual(before);
  expect(await balance(f.bank.id)).toBe("-65.0000");
  expect(await balance(f.card.id)).toBe("65.0000");
  expect(await balance(f.expense.id)).toBe("65.0000");
  expect(await balance(f.income.id)).toBe("-65.0000");
});
it("entry matching can select an ordinary expense counterpart", async () => {
  const card = await connect(f.card.id, "credit");
  await sync(card, [tx(card, "in", "-65", "PAYMENT THANK YOU")]);
  const expense = await createEntry(
    h.db,
    f.ownerId,
    await buildPostings(h.db, f.ownerId, "expense", {
      amount: "65",
      fromAccountId: f.bank.id,
      categoryId: f.category("其他支出"),
      eventDate: "2026-10-22",
      status: "confirmed",
    }),
  );
  const pending = await pendingWorkbench(h.db, f.ownerId, "sandbox");
  expect(pending.transfers).toHaveLength(0);
  const entryId = (await rows())[0].journalEntryId!;
  const detail = await entryMatching(h.db, f.ownerId, entryId);
  expect(detail.candidates.map((leg) => leg.id)).toContain(expense.id);
  expect(detail.diagnostics.join()).toContain("对方账户未连接");
  await resolveEntryMatching(h.db, f.ownerId, entryId, {
    action: "match",
    counterpartEntryId: expense.id,
  });
  await expectMatched("credit_card_payment");
});
it("matching API enforces auth/origin/ownership and activity renders match/unmatch controls", async () => {
  const { debit, credit } = await manualPair();
  const owner = await createSession(h.db, f.ownerId, { ipHash: "synthetic", userAgent: "test" });
  const other = await createSession(h.db, f.otherId, { ipHash: "synthetic", userAgent: "test" });
  const url = `http://localhost:3000/api/transactions/${debit.id}/matching`;
  const context = { params: Promise.resolve({ id: debit.id }) };
  const request = (token?: string, origin = "http://localhost:3000") =>
    new NextRequest(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "localhost:3000",
        origin,
        ...(token ? { cookie: `al_session=${token}` } : {}),
      },
      body: JSON.stringify({ action: "match", counterpartEntryId: credit.id }),
    });
  expect((await matchingRoute.POST(request(), context)).status).toBe(401);
  expect((await matchingRoute.POST(request(other.token), context)).status).toBe(404);
  expect((await matchingRoute.POST(request(owner.token, "https://untrusted.example"), context)).status).toBe(
    403,
  );
  const props = {
    accounts: await listAccounts(h.db, f.ownerId, true),
    categories: f.categories,
    groups: [],
    today: "2026-10-24",
    onSaved: () => {},
  };
  const markup = renderToStaticMarkup(
    <EntryDetailView {...props} entry={await getEntry(h.db, f.ownerId, debit.id)} />,
  );
  expect(markup).toContain("匹配为转账 / 查看诊断");
  expect((await matchingRoute.POST(request(owner.token), context)).status).toBe(200);
  const match = (await entries()).find((entry) => entry.transferMatchId)!;
  expect(
    renderToStaticMarkup(<EntryDetailView {...props} entry={await getEntry(h.db, f.ownerId, match.id)} />),
  ).toContain("取消匹配");
  await expect(resolveEntryMatching(h.db, f.otherId, match.id, { action: "unmatch" })).rejects.toThrow(
    "流水不存在",
  );
});
it("reports an outside-window candidate in entry diagnostics without pending transfer cards", async () => {
  const bank = await connect(f.bank.id, "depository");
  const card = await connect(f.card.id, "credit");
  await sync(bank, [tx(bank, "out", "95", "ACH PMT", { date: "2026-10-10", authorizedDate: "2026-10-10" })]);
  await sync(card, [tx(card, "in", "-95", "PAYMENT THANK YOU")]);
  const data = await pendingWorkbench(h.db, f.ownerId, "sandbox");
  expect(data.transfers).toHaveLength(0);
  expect(
    (await entryMatching(h.db, f.ownerId, (await rows())[0].journalEntryId!)).diagnostics.join(),
  ).toContain("12 天");
  const markup = renderToStaticMarkup(
    <PendingView
      data={jsonSafe(data)}
      accounts={await listAccounts(h.db, f.ownerId, true)}
      categories={f.categories}
    />,
  );
  expect(markup).not.toContain("待匹配转账");
});
it("disabled mappings and review-only connections never contribute automatic matches", async () => {
  const bank = await connect(f.bank.id, "depository");
  const card = await connect(f.card.id, "credit");
  await sync(bank, [tx(bank, "out", "22", "ACH PMT")]);
  await h.db
    .update(bankConnectionAccounts)
    .set({ isEnabled: false })
    .where(eq(bankConnectionAccounts.connectionId, bank.id));
  await sync(card, [tx(card, "in", "-22", "PAYMENT THANK YOU")]);
  expect((await entries()).every((entry) => !entry.transferMatchId)).toBe(true);
  await h.db
    .update(bankConnectionAccounts)
    .set({ isEnabled: true })
    .where(eq(bankConnectionAccounts.connectionId, bank.id));
  await setAutoPost(h.db, f.ownerId, bank.id, config, { autoPost: false });
  await sync(card);
  expect((await entries()).every((entry) => !entry.transferMatchId)).toBe(true);
});

function leg(id: string, changes: Partial<SignalLeg> = {}): SignalLeg {
  return {
    id,
    accountId: id,
    accountName: id,
    accountType: "asset_cash",
    amount: "-10",
    currency: "USD",
    date: "2026-10-22",
    eventDate: "2026-10-22",
    description: "ACH PMT",
    canAutoMatch: true,
    aliases: [],
    mask: null,
    primary: null,
    ...changes,
  };
}
it("never pairs cash advance spending even when both sides have account hints", () => {
  const out = leg("cash", {
    description: "CASH-ADVANCE transfer to Citi 1234",
    aliases: ["example bank"],
    primary: "TRANSFER_OUT",
  });
  const incoming = leg("card", {
    amount: "10",
    accountType: "liability_credit_card",
    description: "payment from Example Bank",
    aliases: ["citi"],
    mask: "1234",
    primary: "TRANSFER_IN",
  });
  expect(counterpartyHint(out, incoming)).toBe(true);
  expect(counterpartyHint(incoming, out)).toBe(true);
  expect(signalStrength(out, incoming)).toBe(0);
  expect(signalStrength(incoming, out)).toBe(0);
  expect(strongestCandidates(out, [out, incoming])).toEqual([]);
});
it("ranks mutual hints above one hint above keywords, never resolves equal-rank ties", () => {
  const a = leg("bank", { aliases: ["north checking"], description: "ACH PMT Citi" });
  const b = leg("strong", {
    amount: "10",
    accountType: "liability_credit_card",
    aliases: ["citi"],
    description: "north checking AUTOPAY",
  });
  const c = leg("one", { ...b, id: "one", accountId: "one", description: "AUTOPAY" });
  const d = leg("weak", { amount: "10", accountType: "liability_credit_card", description: "AUTOPAY" });
  expect([signalStrength(a, b), signalStrength(a, c), signalStrength(a, d)]).toEqual([3, 2, 1]);
  expect(strongestCandidates(a, [a, b, c, d]).map((entry) => entry.id)).toEqual([b.id]);
  expect(strongestCandidates(a, [a, c, { ...c, id: "tie", accountId: "tie" }])).toHaveLength(2);
});
it.each([
  ["American Express", "AMEX"],
  ["Citi", "CITIBANK"],
  ["Bank of America", "BKOFAMERICA"],
  ["Capital One", "CAP ONE"],
  ["Bilt", "CARDLESS"],
  ["U.S. Bank", "USBANK"],
  ["X Money", "X.COM"],
])("recognizes institution phrase aliases %s / %s without generic tokens", (name, description) => {
  const target = leg("target", {
    aliases: accountAliases({ institutionName: name, plaidInstitutionName: name }),
    mask: "1234",
  });
  expect(counterpartyHint(leg("source", { description }), target)).toBe(true);
  expect(
    counterpartyHint(leg("source", { description: "ONLINE PAYMENT BANK CARD MONEY 99123499" }), target),
  ).toBe(false);
  expect(counterpartyHint(leg("source", { description: "from card 1234" }), target)).toBe(true);
});
it("protects plain card refunds/deposits and PFC-only card funding, but permits explicit hints", () => {
  const debit = leg("debit", { primary: "TRANSFER_OUT" });
  const refund = leg("refund", {
    amount: "10",
    accountType: "liability_credit_card",
    description: "Store refund",
  });
  const deposit = leg("deposit", { amount: "10", description: "ATM DEPOSIT", primary: "TRANSFER_IN" });
  expect(signalStrength(debit, refund)).toBe(0);
  expect(signalStrength(debit, deposit)).toBe(0);
  const charge = leg("card", {
    accountType: "liability_credit_card",
    description: "Store purchase",
    primary: "TRANSFER_OUT",
  });
  expect(
    signalStrength(charge, leg("in", { amount: "10", description: "Cash inflow", primary: "TRANSFER_IN" })),
  ).toBe(0);
  expect(signalStrength({ ...debit, description: "to card 1234" }, { ...refund, mask: "1234" })).toBe(2);
  expect(dateDistance(debit, { ...deposit, date: "2026-11-01", eventDate: "2026-10-23" })).toBe(1);
});
it("backfill generation re-scans old posted entries beyond 120 days even with no new rows", async () => {
  const bank = await connect(f.bank.id, "depository", "Example Bank", "2026-05-01", false);
  const card = await connect(f.card.id, "credit", "Capital One", "2026-05-01", false);
  const dates = { date: "2026-05-10", authorizedDate: "2026-05-10" };
  await sync(bank, [tx(bank, "old-out", "110", "CAPITAL ONE MOBILE PMT", dates)]);
  await sync(card, [tx(card, "old-in", "-110", "CAPITAL ONE AUTOPAY PYMT", dates)]);
  for (const row of await rows())
    await legacyPost(row.id, row.accountId === f.bank.id ? "expense" : "refund");
  for (const c of [bank, card]) await setAutoPost(h.db, f.ownerId, c.id, config, { autoPost: true });
  await h.db
    .update(bankConnections)
    .set({ matchingVersion: 2, matchingGeneration: 0 })
    .where(eq(bankConnections.ownerId, f.ownerId));
  await sync(bank);
  expect(await entries()).toHaveLength(2);
  expect((await entries()).every((entry) => !entry.transferMatchId)).toBe(true);
  await executeBackfill(h.db, f.ownerId, bank.id, config, { from: "2026-04-01" }, now);
  await sync(bank);
  await expectMatched("credit_card_payment");
  const [connection] = await h.db.select().from(bankConnections).where(eq(bankConnections.id, bank.id));
  expect(connection.matchingGeneration).toBe(connection.syncGeneration);
});
it.each(["posted", "upstream", "resolved"] as const)(
  "counts a manually replaced Plaid entry (%s) toward ambiguity without modifying or relinking it",
  async (state) => {
    const bank = await connect(f.bank.id, "depository");
    const card = await connect(f.card.id, "credit", "Citi");
    await sync(card, [tx(card, "first", "-42", "PAYMENT THANK YOU"), tx(card, "second", "-42", "AUTOPAY")]);
    const firstRow = (await rows()).find((row) => row.providerTransactionId === "first")!;
    const original = await getEntry(h.db, f.ownerId, firstRow.journalEntryId!);
    const replacement = await replaceEntry(
      h.db,
      f.ownerId,
      original.id,
      {
        ...(await buildPostings(h.db, f.ownerId, "refund", {
          amount: "42",
          toAccountId: f.card.id,
          categoryId: f.category("购物"),
          eventDate: "2026-10-22",
          merchant: "PAYMENT THANK YOU",
          status: "confirmed",
        })),
        source: "manual",
      },
      "Owner explicitly corrected classification",
    );
    await h.db
      .update(importRows)
      .set({ autoPostState: state, upstreamState: state === "upstream" ? "modified" : "none" })
      .where(eq(importRows.id, firstRow.id));
    await sync(bank, [tx(bank, "out", "42", "Bill Payment to Citi")]);
    const pending = await pendingWorkbench(h.db, f.ownerId, "sandbox");
    expect(pending.transfers).toHaveLength(0);
    const out = await entryMatching(
      h.db,
      f.ownerId,
      (await rows()).find((row) => row.accountId === f.bank.id)!.journalEntryId!,
    );
    expect(out.candidates).toHaveLength(2);
    expect(out.diagnostics.join()).toContain("多个同等信号候选");
    expect(out.diagnostics.join()).toContain("所有者编辑");
    expect((await getEntry(h.db, f.ownerId, replacement.id)).entryType).toBe("refund");
    expect((await rows()).find((row) => row.id === firstRow.id)?.journalEntryId).toBe(original.id);
    expect((await entries()).every((entry) => !entry.transferMatchId)).toBe(true);
  },
);
it("never treats account product words like Plus as institution evidence", async () => {
  await updateAccount(h.db, f.ownerId, f.bank.id, { name: "Plus Preferred Checking" });
  const bank = await connect(f.bank.id, "depository", "Example Bank");
  const card = await connect(f.card.id, "credit", "Citi");
  await sync(card, [tx(card, "grocer", "50", "PLUS MARKET")]);
  await sync(bank, [tx(bank, "incoming", "-50", "Zelle from Alex Sample")]);
  expect((await entries()).every((entry) => !entry.transferMatchId)).toBe(true);
  expect((await entries()).map((entry) => entry.entryType).sort()).toEqual(["expense", "income"]);
  expect(await balance(f.expense.id)).toBe("50.0000");
  expect((await pendingWorkbench(h.db, f.ownerId, "sandbox")).count).toBe(1);
});

it.each([
  ["cash", "60", "expense", "60.0000", "0.0000"],
  ["cash", "-60", "income", "0.0000", "-60.0000"],
  ["card", "60", "expense", "60.0000", "0.0000"],
  ["card", "-60", "income", "0.0000", "-60.0000"],
])(
  "falls back unmatched %s amount %s to %s with no transfer card",
  async (kind, amount, type, spending, income) => {
    const c = await connect(
      kind === "cash" ? f.bank.id : f.card.id,
      kind === "cash" ? "depository" : "credit",
    );
    await sync(c, [tx(c, "unmatched", amount, "ONLINE PAYMENT")]);
    const entry = await getEntry(h.db, f.ownerId, (await rows())[0].journalEntryId!);
    expect(entry.entryType).toBe(type);
    expect(entry.postings.find((line) => line.categoryId)?.categoryId).toBe(
      f.category(type === "income" ? "其他收入" : "其他支出"),
    );
    expect(await balance(f.expense.id)).toBe(spending);
    expect(await balance(f.income.id)).toBe(income);
    expect((await pendingWorkbench(h.db, f.ownerId, "sandbox")).transfers).toEqual([]);
  },
);

it.each([false, true])(
  "delayed payment/wallet funding reverses fallback spending, card-funded=%s",
  async (funded) => {
    const bank = await connect(f.bank.id, "depository", "Example Bank");
    const card = await connect(f.card.id, "credit", "Citi");
    const out = funded ? card : bank;
    const incoming = funded ? bank : card;
    await sync(out, [tx(out, "out", "44", funded ? "TRANSFER TO Example Bank" : "PAYMENT TO Citi")]);
    const original = (await rows())[0].journalEntryId!;
    expect(await balance(f.expense.id)).toBe("44.0000");
    await sync(incoming, [tx(incoming, "in", "-44", funded ? "TRANSFER FROM Citi" : "PAYMENT THANK YOU")]);
    const pair = await expectMatched(funded ? "transfer" : "credit_card_payment");
    expect(pair.some((entry) => entry.replacesEntryId === original)).toBe(true);
    expect((await getEntry(h.db, f.ownerId, original)).status).toBe("voided");
    expect((await rows()).every((row) => pair.some((entry) => entry.id === row.journalEntryId))).toBe(true);
  },
);

async function legacyClearing(rowId: string) {
  const row = (await rows()).find((row) => row.id === rowId)!;
  const entry = await createEntry(h.db, f.ownerId, await clearingInput(h.db, f.ownerId, row));
  await h.db
    .update(journalEntries)
    .set({ providerAccountId: row.accountId, providerTransactionId: row.providerTransactionId })
    .where(eq(journalEntries.id, entry.id));
  await stampAutoEntry(h.db, f.ownerId, entry.id);
  await h.db
    .update(importRows)
    .set({ journalEntryId: entry.id, autoPostState: "posted", decision: "approve" })
    .where(eq(importRows.id, rowId));
  return entry;
}
it("cleans legacy unmatched clearing once after matching, preserving owner edits and owner-made legs", async () => {
  const bank = await connect(f.bank.id, "depository", "Example Bank", "2026-10-01", false);
  await sync(bank, [tx(bank, "clean", "31", "ACH PMT"), tx(bank, "edited", "32", "ACH PMT")]);
  const clean = await legacyClearing((await rows()).find((row) => row.providerTransactionId === "clean")!.id);
  const edited = await legacyClearing(
    (await rows()).find((row) => row.providerTransactionId === "edited")!.id,
  );
  await updateEntryMeta(h.db, f.ownerId, edited.id, { notes: "Owner decision" });
  const manual = await createEntry(h.db, f.ownerId, {
    ...(await clearingInput(h.db, f.ownerId, {
      accountId: f.bank.id,
      amount: "-33",
      currency: "USD",
      transactionDate: "2026-10-22",
      postedDate: null,
      merchantNormalized: "",
      descriptionRaw: "Owner transfer",
    })),
    source: "manual",
  });
  await setAutoPost(h.db, f.ownerId, bank.id, config, { autoPost: true });
  await sync(bank);
  const replacement = (await entries()).find((entry) => entry.replacesEntryId === clean.id)!;
  expect(replacement.entryType).toBe("expense");
  expect((await getEntry(h.db, f.ownerId, clean.id)).voidReason).toBe("未匹配转账改为收支");
  expect((await getEntry(h.db, f.ownerId, edited.id)).status).toBe("confirmed");
  expect((await getEntry(h.db, f.ownerId, manual.id)).status).toBe("confirmed");
  expect((await pendingWorkbench(h.db, f.ownerId, "sandbox")).transfers.map((leg) => leg.id).sort()).toEqual(
    [edited.id, manual.id].sort(),
  );
  const before = await entries();
  await sync(bank);
  expect(await entries()).toEqual(before);
  expect((await rows()).find((row) => row.providerTransactionId === "clean")!.journalEntryId).toBe(
    replacement.id,
  );
});
it("matches a legacy clearing leg before fallback when the counterpart arrives in the same sync", async () => {
  const bank = await connect(f.bank.id, "depository", "Example Bank", "2026-10-01", false);
  const card = await connect(f.card.id, "credit", "Citi");
  await sync(bank, [tx(bank, "old", "49", "Citi PAYMENT")]);
  const legacy = await legacyClearing((await rows())[0].id);
  await setAutoPost(h.db, f.ownerId, bank.id, config, { autoPost: true });
  await sync(card, [tx(card, "new", "-49", "PAYMENT THANK YOU")]);
  expect((await expectMatched("credit_card_payment")).map((entry) => entry.id)).toContain(legacy.id);
  expect((await entries()).filter((entry) => entry.status === "voided")).toHaveLength(0);
});
it("assigns from entry detail, rejects invalid/foreign accounts, and preserves loan clearing on unmatch", async () => {
  const { debit } = await manualPair();
  const foreign = await createAccount(h.db, f.otherId, {
    name: "Other cash",
    type: "asset_cash",
    currency: "USD",
  });
  const inactive = await createAccount(h.db, f.ownerId, {
    name: "Inactive",
    type: "asset_cash",
    currency: "USD",
    isActive: false,
  });
  for (const accountId of [f.security.id, f.income.id, f.wallet.id, f.bank.id, foreign.id, inactive.id]) {
    await expect(
      resolveEntryMatching(h.db, f.ownerId, debit.id, { action: "assign", accountId }),
    ).rejects.toThrow();
  }
  await expect(
    resolveEntryMatching(h.db, f.otherId, debit.id, { action: "assign", accountId: foreign.id }),
  ).rejects.toThrow("不存在");
  const loan = await createAccount(h.db, f.ownerId, {
    name: "Demo Loan",
    type: "liability_loan",
    currency: "USD",
  });
  const matching = await entryMatching(h.db, f.ownerId, debit.id);
  expect(matching.accounts.map((account) => account.id)).toContain(loan.id);
  expect(matching.accounts.map((account) => account.id)).not.toContain(foreign.id);
  const { transferMatchId } = await resolveEntryMatching(h.db, f.ownerId, debit.id, {
    action: "assign",
    accountId: loan.id,
  });
  const pair = (await entries()).filter((entry) => entry.transferMatchId === transferMatchId);
  expect(pair).toHaveLength(2);
  await resolveEntryMatching(h.db, f.ownerId, pair[0].id, { action: "unmatch" });
  const pending = await pendingWorkbench(h.db, f.ownerId, "sandbox");
  expect(pending.transfers).toHaveLength(1);
  expect(pending.transfers[0].accountId).toBe(loan.id);
  expect((await getEntry(h.db, f.ownerId, pending.transfers[0].id)).autoPostOwnerEdited).toBe(true);
});
it("paginates pairs once, filters either side, and renders both sides without clearing labels", async () => {
  const bank = await connect(f.bank.id, "depository");
  const card = await connect(f.card.id, "credit", "Citi");
  await sync(bank, [
    tx(bank, "out", "80", "Citi PAYMENT", { date: "2026-10-18", authorizedDate: "2026-10-18" }),
  ]);
  await sync(card, [tx(card, "in", "-80", "PAYMENT THANK YOU", { date: "2026-10-22" })]);
  const pair = await expectMatched("credit_card_payment");
  const first = await listEntries(h.db, f.ownerId, { status: "confirmed", limit: 1 });
  expect(first.total).toBe(1);
  expect(first.entries).toHaveLength(1);
  const transfer = first.entries[0].transfer!;
  expect(transfer).toMatchObject({
    type: "credit_card_payment",
    amount: "80.0000",
    currency: "USD",
    from: { accountName: f.bank.name, date: "2026-10-18", description: "Citi PAYMENT" },
    to: { accountName: f.card.name, date: "2026-10-22", description: "PAYMENT THANK YOU" },
  });
  expect(first.entries[0].id).toBe(transfer.from.entryId);
  for (const filters of [
    { accountId: f.bank.id },
    { accountId: f.card.id },
    { from: "2026-10-22", to: "2026-10-22" },
    { merchant: "THANK YOU" },
    { minAmount: "80", maxAmount: "80", currency: "USD" },
    { type: "credit_card_payment" as const },
  ]) {
    expect(
      (await listEntries(h.db, f.ownerId, { ...filters, status: "confirmed" })).entries.map(
        (entry) => entry.id,
      ),
    ).toEqual([transfer.from.entryId]);
  }
  expect((await listEntries(h.db, f.ownerId, { status: "confirmed", limit: 1, offset: 1 })).entries).toEqual(
    [],
  );
  expect((await listEntries(h.db, f.ownerId, { status: "confirmed", minAmount: "81" })).total).toBe(0);
  expect((await listEntries(h.db, f.otherId)).total).toBe(0);
  const props = {
    accounts: await listAccounts(h.db, f.ownerId, true),
    categories: f.categories,
    groups: [],
    today: "2026-10-24",
  };
  const label = `${f.bank.name} → ${f.card.name}`;
  const activity = renderToStaticMarkup(
    <ActivityView
      {...props}
      data={first}
      settings={{ prepaymentMode: "asset", spendingDateBasis: "posted" }}
      filters={{}}
    />,
  );
  expect(activity).toContain(label);
  expect(activity).not.toContain("待匹配转账");
  for (const leg of pair) {
    const detail = renderToStaticMarkup(
      <EntryDetailView {...props} entry={await getEntry(h.db, f.ownerId, leg.id)} onSaved={() => {}} />,
    );
    expect(detail).toContain(label);
    expect(detail).toContain("2026-10-18");
    expect(detail).toContain("2026-10-22");
    expect(detail).toContain("PAYMENT THANK YOU");
    expect(detail).toContain("取消匹配");
    expect(detail).not.toContain("待匹配转账");
  }
  const pending = await pendingWorkbench(h.db, f.ownerId, "sandbox");
  expect(pending.recent).toHaveLength(1);
  expect(renderToStaticMarkup(<PendingView {...props} data={jsonSafe(pending)} />)).toContain(label);
  // A second pair and an ordinary entry exercise adjacent page boundaries and transfer type filters.
  await sync(bank, [tx(bank, "other", "12", "TRANSFER", { date: "2026-10-23" })]);
  const other = (await rows()).find((row) => row.providerTransactionId === "other")!;
  await resolveEntryMatching(h.db, f.ownerId, other.journalEntryId!, {
    action: "assign",
    accountId: f.broker.id,
  });
  expect((await listEntries(h.db, f.ownerId, { status: "confirmed", type: "transfer" })).total).toBe(1);
  const pages = await Promise.all(
    [0, 1].map((offset) => listEntries(h.db, f.ownerId, { status: "confirmed", offset, limit: 1 })),
  );
  expect(pages.every((page) => page.total === 2)).toBe(true);
  expect(new Set(pages.flatMap((page) => page.entries.map((entry) => entry.id))).size).toBe(2);
});

it("keeps a matched automatic inflow in recent entries when the outflow was owner-assigned", async () => {
  const card = await connect(f.card.id, "credit");
  await sync(card, [tx(card, "inferred-payment", "-28", "PAYMENT THANK YOU")]);
  await resolveEntryMatching(h.db, f.ownerId, (await rows())[0].journalEntryId!, {
    action: "assign",
    accountId: f.bank.id,
  });
  const recent = (await pendingWorkbench(h.db, f.ownerId, "sandbox")).recent;
  expect(recent).toHaveLength(1);
  expect(recent[0].transfer).toMatchObject({
    amount: "28.0000",
    from: { accountName: f.bank.name },
    to: { accountName: f.card.name },
  });
  expect(recent[0].id).toBe(recent[0].transfer!.from.entryId);
});

it("voiding a matched leg restores the peer as owner-protected income", async () => {
  const { debit, credit } = await manualPair();
  const matched = await resolveEntryMatching(h.db, f.ownerId, debit.id, {
    action: "match",
    counterpartEntryId: credit.id,
  });
  const pair = (await entries()).filter((entry) => entry.transferMatchId === matched.transferMatchId);
  const outgoing = pair.find((entry) => entry.replacesEntryId === debit.id)!;
  const incoming = pair.find((entry) => entry.replacesEntryId === credit.id)!;
  await voidEntry(h.db, f.ownerId, outgoing.id, "Owner correction");
  expect((await getEntry(h.db, f.ownerId, incoming.id)).status).toBe("voided");
  const current = (await entries()).filter((entry) => entry.status === "confirmed");
  expect(current).toHaveLength(1);
  expect(current[0]).toMatchObject({
    entryType: "income",
    replacesEntryId: incoming.id,
    transferMatchId: null,
    autoPostOwnerEdited: true,
  });
  expect(await balance(f.income.id)).toBe("-65.0000");
  expect((await pendingWorkbench(h.db, f.ownerId, "sandbox")).transfers).toEqual([]);
});

it("cleans benefit-like legacy clearing outside the benefit rescan window", async () => {
  const card = await connect(f.card.id, "credit", "Example Card", "2025-01-01", false);
  await sync(card, [
    tx(card, "old-benefit", "-18", "DINING CREDIT", { date: "2025-03-01", authorizedDate: "2025-03-01" }),
  ]);
  const old = await legacyClearing((await rows())[0].id);
  await h.db.update(bankConnections).set({ benefitVersion: 2 }).where(eq(bankConnections.id, card.id));
  await setAutoPost(h.db, f.ownerId, card.id, config, { autoPost: true });
  await sync(card);
  const current = await getEntry(h.db, f.ownerId, (await rows())[0].journalEntryId!);
  expect(current).toMatchObject({
    entryType: "refund",
    benefitCredit: true,
    benefitFamily: "dining",
    replacesEntryId: old.id,
    eventDate: "2025-03-01",
  });
  expect(current.postings.find((line) => line.categoryId)?.categoryId).toBe(f.category("餐饮"));
  expect((await pendingWorkbench(h.db, f.ownerId, "sandbox")).transfers).toEqual([]);
  const before = await entries();
  await sync(card);
  expect(await entries()).toEqual(before);
});

it.each(["12345", "2345"])(
  "keeps a five-digit suffix through Plaid mapping/sync and matches hint %s",
  async (hint) => {
    await updateAccount(h.db, f.ownerId, f.card.id, { last4: "12345" });
    const card = await connect(f.card.id, "credit", "Demo Card Issuer");
    card.client.accountRows[0].mask = "2345";
    const bank = await connect(f.bank.id, "depository", "Example Bank");
    await sync(card, [tx(card, "in", "-43", "PAYMENT THANK YOU")]);
    await sync(bank, [tx(bank, "out", "43", `to card ${hint}`)]);
    expect((await listAccounts(h.db, f.ownerId)).find((row) => row.id === f.card.id)?.last4).toBe("12345");
    await expectMatched("credit_card_payment");
  },
);
it.each([
  ["card 12345", true],
  ["card XXXX12345", true],
  ["card 2345", true],
  ["card 923459", false],
  ["card 234", false],
])("checks five-digit hint token rules for %s", (description, expected) => {
  expect(counterpartyHint(leg("source", { description }), leg("target", { mask: "12345" }))).toBe(expected);
});

it.each(["LOAN_PAYMENTS", "TRANSFER_IN"])(
  "protects offer refunds from %s matching hints, suggestions and income fallback",
  async (primary) => {
    const card = await connect(f.card.id, "credit", "Example Card Issuer");
    const bank = await connect(f.bank.id, "depository", "Example Bank");
    await sync(card, [
      tx(card, "merchant-offer", "-28", "Example Bank MERCHANT OFFER CREDIT 9876", { primary }),
    ]);
    await sync(bank, [tx(bank, "out", "28", "to card 1234")]);
    const offerRow = (await rows()).find((row) => row.providerTransactionId === "merchant-offer")!;
    const entry = await getEntry(h.db, f.ownerId, offerRow.journalEntryId!);
    expect(entry).toMatchObject({
      entryType: "refund",
      benefitCredit: false,
      benefitFamily: null,
      transferMatchId: null,
    });
    expect((await pendingWorkbench(h.db, f.ownerId, "sandbox")).suggestions).toEqual([]);
    expect((await fallbackInput(h.db, f.ownerId, offerRow)).entryType).toBe("refund");
    const incoming = leg("offer", {
      amount: "28",
      accountType: "liability_credit_card",
      description: "Example Bank OFFER CREDIT 9876",
      primary,
    });
    const outgoing = leg("out", { amount: "-28", aliases: ["example bank"], mask: "9876" });
    expect(counterpartyHint(incoming, outgoing)).toBe(true);
    expect(signalStrength(incoming, outgoing)).toBe(0);
    expect(isTransferLike(incoming)).toBe(false);
    expect(
      classifyTransaction(tx(card, "offer", "-28", incoming.description, { primary }), "credit").type,
    ).toBe("refund");
    // Explicit payment language still wins over offer wording.
    expect(isTransferLike({ ...incoming, description: "PAYMENT THANK YOU OFFER" })).toBe(true);
  },
);
it("recent automatic postings omit an actually imported, voided entry", async () => {
  const card = await connect(f.card.id, "credit");
  await sync(card, [tx(card, "ordinary", "11", "Example Merchant")]);
  const entry = (await entries())[0];
  expect((await pendingWorkbench(h.db, f.ownerId, "sandbox")).recent.map((row) => row.id)).toContain(
    entry.id,
  );
  await voidEntry(h.db, f.ownerId, entry.id, "Synthetic void");
  expect((await pendingWorkbench(h.db, f.ownerId, "sandbox")).recent.map((row) => row.id)).not.toContain(
    entry.id,
  );
});
