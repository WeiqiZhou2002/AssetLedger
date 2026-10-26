import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import {
  accounts,
  auditLogs,
  bankConnections,
  bankConnectionAccounts,
  importRows,
  journalEntries,
  postings,
  purchaseGroups,
  statements,
  transferPairRejections,
  users,
} from "@/db/schema";
import { createEntry, getEntry, replaceEntry, voidEntry } from "@/lib/ledger/entries";
import { createAccount, getSystemAccount } from "@/lib/ledger/accounts";
import type { EntryInput } from "@/lib/ledger/schemas";
import { accountBalance } from "@/lib/ledger/queries";
import { money } from "@/lib/money";
import { stampAutoEntry } from "@/lib/bank-sync/auto-state";
import * as matchPool from "@/lib/bank-sync/match-pool";
import { matchUniqueLegs } from "@/lib/bank-sync/transfer-legs";
import { pendingCount, pendingWorkbench } from "@/lib/bank-sync/pending";
import {
  computeTransferSuggestions,
  resolveTransferSuggestion,
  transferSuggestions,
} from "@/lib/bank-sync/transfer-suggestions";
import { createSession } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { deleteOwnerData, DELETE_CONFIRMATION } from "@/lib/data/delete";
import { exportOwnerData } from "@/lib/data/export";
import { ownerTables } from "@/lib/data/tables";
import { TransferSuggestions } from "@/components/bank-sync/pending-view";
import { AppNavigation } from "@/components/app-navigation";

let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
const now = new Date("2026-10-25T12:00:00Z");
vi.mock("@/db/client", () => ({ getDb: () => h.db }));
vi.mock("@/lib/auth/current-user", () => ({
  requireUser: async () => ({ id: f.ownerId, timezone: "America/Los_Angeles" }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/statements",
}));
const route = await import("@/app/api/transfer-suggestions/route");
const { default: StatementsPage } = await import("@/app/(app)/statements/page");
beforeAll(async () => {
  h = await createTestDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("APP_SECRET", "synthetic-transfer-suggestions-secret-32");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic/test");
  vi.stubEnv("PLAID_ENABLED", "false");
});
afterAll(async () => {
  await h.client.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.setSystemTime(now);
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
});
type Account = typeof accounts.$inferSelect;
async function input(
  account: Account,
  amount: string,
  date = "2026-10-22",
  extra: Partial<EntryInput> = {},
): Promise<EntryInput> {
  const out = money(amount).lt(0);
  const type = out ? "expense" : account.type === "liability_credit_card" ? "refund" : "income";
  const nominal = await getSystemAccount(
    h.db,
    f.ownerId,
    type === "income" ? "income" : "expense",
    account.currency,
  );
  return {
    entryType: type,
    status: "confirmed",
    source: "import",
    eventDate: date,
    description: "Synthetic merchant record",
    postings: [
      { accountId: account.id, amount, currency: account.currency },
      {
        accountId: nominal.id,
        amount: money(amount).negated().toFixed(4),
        currency: account.currency,
        categoryId: f.category(type === "income" ? "其他收入" : "其他支出"),
      },
    ],
    ...extra,
  };
}
async function entry(account: Account, amount: string, date?: string, extra?: Partial<EntryInput>) {
  return createEntry(h.db, f.ownerId, await input(account, amount, date, extra));
}
async function clearing(account: Account, amount: string) {
  const nominal = await getSystemAccount(h.db, f.ownerId, "transfer_clearing", account.currency);
  return entry(account, amount, undefined, {
    entryType: "transfer",
    externalReference: "transfer:manual",
    postings: [
      { accountId: account.id, amount, currency: account.currency },
      { accountId: nominal.id, amount: money(amount).negated().toFixed(4), currency: account.currency },
    ],
  });
}
const suggestions = () => transferSuggestions(h.db, f.ownerId);
const resolve = (
  a: { id: string },
  b: { id: string },
  action: "confirm" | "reject" = "reject",
  ownerId = f.ownerId,
) => resolveTransferSuggestion(h.db, ownerId, { action, entryId: a.id, counterpartEntryId: b.id });
const current = () =>
  h.db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.ownerId, f.ownerId), eq(journalEntries.status, "confirmed")));
async function automatic(
  original: { id: string },
  account: Account,
  providerId: string,
  environment: "sandbox" | "production" = "sandbox",
) {
  let [connection] = await h.db
    .select()
    .from(bankConnections)
    .where(and(eq(bankConnections.ownerId, f.ownerId), eq(bankConnections.plaidItemId, account.id)));
  if (!connection) {
    [connection] = await h.db
      .insert(bankConnections)
      .values({
        ownerId: f.ownerId,
        environment,
        plaidItemId: account.id,
        institutionName: "Example Bank",
        accessTokenEnc: "synthetic-unused",
        importFromDate: "2026-01-01",
      })
      .returning();
    await h.db.insert(bankConnectionAccounts).values({
      ownerId: f.ownerId,
      connectionId: connection.id,
      plaidAccountId: account.id,
      name: account.name,
      type: account.type === "liability_credit_card" ? "credit" : "depository",
      accountId: account.id,
      isEnabled: true,
    });
  }
  const record = await getEntry(h.db, f.ownerId, original.id);
  const amount = record.postings.find((line) => line.accountId === account.id)!.amount;
  let [statement] = await h.db
    .select()
    .from(statements)
    .where(and(eq(statements.ownerId, f.ownerId), eq(statements.connectionId, connection.id)));
  if (!statement)
    [statement] = await h.db
      .insert(statements)
      .values({ ownerId: f.ownerId, source: "plaid", connectionId: connection.id, syncDate: "2026-10-25" })
      .returning();
  const previousRows = await h.db
    .select({ id: importRows.id })
    .from(importRows)
    .where(eq(importRows.statementId, statement.id));
  const [row] = await h.db
    .insert(importRows)
    .values({
      ownerId: f.ownerId,
      statementId: statement.id,
      rowIndex: previousRows.length + 1,
      accountId: account.id,
      bankConnectionId: connection.id,
      source: "plaid",
      sourceRowText: "Synthetic evidence",
      transactionDate: record.eventDate,
      postedDate: record.postedDate,
      descriptionRaw: record.description!,
      merchantNormalized: "",
      amountRaw: amount,
      amount,
      currency: account.currency,
      direction: money(amount).lt(0) ? "debit" : "credit",
      confidence: "1",
      providerTransactionId: providerId,
      rowSignature: original.id,
      journalEntryId: original.id,
      autoPostState: "posted",
      decision: "approve",
    })
    .returning();
  await stampAutoEntry(h.db, f.ownerId, original.id);
  return row;
}

it("keeps signal-free automatic card funding as expense/income and suggests one three-day pair", async () => {
  const a = await entry(f.card, "-80", "2026-10-19");
  const b = await entry(f.bank, "80", "2026-10-22");
  await automatic(a, f.card, "synthetic-charge");
  await automatic(b, f.bank, "synthetic-deposit");
  expect(await matchUniqueLegs(h.db, f.ownerId, "sandbox")).toBe(0);
  const pairs = await suggestions();
  expect(pairs).toHaveLength(1);
  expect(pairs[0]).toMatchObject({ type: "transfer", days: 3, alternatives: 0 });
  expect((await current()).map((row) => row.entryType).sort()).toEqual(["expense", "income"]);
  for (const hidden of [
    "aliases",
    "mask",
    "primary",
    "upstreamPayload",
    "legKey",
    "synthetic-charge",
    "synthetic-deposit",
  ])
    expect(JSON.stringify(pairs)).not.toContain(hidden);
});
it.each(["six days", "same account", "currency", "amount", "incompatible types"])(
  "excludes %s",
  async (kind) => {
    await entry(f.card, "-80", "2026-10-16");
    await entry(
      kind === "same account"
        ? f.card
        : kind === "incompatible types"
          ? await createAccount(h.db, f.ownerId, {
              name: "Another Demo Card",
              type: "liability_credit_card",
              currency: "USD",
            })
          : kind === "currency"
            ? f.wallet
            : f.bank,
      kind === "amount" ? "81" : "80",
      kind === "six days" ? "2026-10-22" : "2026-10-19",
    );
    expect(await suggestions()).toEqual([]);
  },
);
it("types a checking expense and unlinked card refund as credit card payment", async () => {
  await entry(f.bank, "-80");
  await entry(f.card, "80");
  expect((await suggestions())[0].type).toBe("credit_card_payment");
});
it("keeps both-clearing ambiguity in pending cards, but suggests clearing plus expense", async () => {
  await clearing(f.bank, "-80");
  await clearing(f.card, "80");
  await clearing(f.broker, "80");
  const pending = await pendingWorkbench(h.db, f.ownerId, "sandbox");
  expect(pending.transfers).toHaveLength(3);
  expect(pending.transfers.find((leg) => leg.accountId === f.bank.id)!.candidates).toHaveLength(2);
  expect(pending.suggestions).toEqual([]);
  await entry(f.bank, "-80");
  expect(await suggestions()).toHaveLength(2);
});
it.each([
  "opening",
  "adjustment",
  "benefit",
  "purchase group",
  "refund link",
  "refunded",
  "voided",
  "draft",
  "matched",
  "old",
  "future",
  "nominal account",
])("excludes %s entries", async (kind) => {
  const a = await entry(
    f.card,
    "-80",
    kind === "old" ? "2025-10-24" : kind === "future" ? "2026-10-26" : undefined,
  );
  await entry(f.bank, "80", kind === "old" ? "2025-10-24" : undefined);
  const changes: Partial<typeof journalEntries.$inferInsert> = {};
  if (kind === "opening") changes.entryType = "opening_balance";
  if (kind === "adjustment") changes.entryType = "balance_adjustment";
  if (kind === "benefit") changes.benefitCredit = true;
  if (kind === "draft") changes.status = "draft";
  if (kind === "matched") changes.transferMatchId = randomUUID();
  if (kind === "purchase group") {
    const [group] = await h.db
      .insert(purchaseGroups)
      .values({ ownerId: f.ownerId, title: "Synthetic group", currency: "USD" })
      .returning();
    changes.purchaseGroupId = group.id;
  }
  if (kind === "refund link") changes.refundOfEntryId = (await entry(f.card, "-7")).id;
  if (kind === "refunded") await entry(f.card, "7", undefined, { refundOfEntryId: a.id });
  if (kind === "voided") await voidEntry(h.db, f.ownerId, a.id, "Synthetic void");
  if (kind === "nominal account") {
    const nominal = await getSystemAccount(h.db, f.ownerId, "fx_clearing", "USD");
    await h.db
      .update(postings)
      .set({ accountId: nominal.id, categoryId: null })
      .where(and(eq(postings.journalEntryId, a.id), eq(postings.accountId, f.expense.id)));
  }
  if (Object.keys(changes).length)
    await h.db.update(journalEntries).set(changes).where(eq(journalEntries.id, a.id));
  expect(await suggestions()).toEqual([]);
});
it("uses owner local today, includes the 365-day boundary, and uses posted fallback event", async () => {
  await entry(f.card, "-80", "2025-10-25");
  await entry(f.bank, "80", "2025-10-25");
  expect(await suggestions()).toHaveLength(1);
  await entry(f.card, "-90", "2025-01-01", { postedDate: "2026-10-25" });
  await entry(f.bank, "90", "2026-10-25");
  expect(await suggestions()).toHaveLength(2);
  vi.setSystemTime(new Date("2026-10-25T06:00:00Z")); // Oct 24 in Los Angeles.
  expect(await suggestions()).toHaveLength(1);
  await h.db.update(users).set({ timezone: "UTC" }).where(eq(users.id, f.ownerId));
  expect(await suggestions()).toHaveLength(2);
});
it("does not exclude an entry referenced only by a draft refund", async () => {
  const a = await entry(f.card, "-80");
  await entry(f.bank, "80");
  await entry(f.card, "7", undefined, { status: "draft", refundOfEntryId: a.id });
  expect(await suggestions()).toHaveLength(1);
});
it("sorts by latest date then distance and counts all shared alternatives once", async () => {
  await entry(f.card, "-80", "2026-10-20");
  await entry(f.bank, "80", "2026-10-22");
  await entry(f.broker, "80", "2026-10-23");
  await entry(f.card, "-80", "2026-10-23");
  const pairs = await suggestions();
  expect(pairs).toHaveLength(4);
  expect(pairs.map((pair) => pair.days)).toEqual([0, 1, 3, 2]);
  expect(pairs.every((pair) => pair.alternatives === 2)).toBe(true);
});
it("confirms manual/imported entries by void+replacement, removes shared suggestions and rejects replay", async () => {
  const a = await entry(f.card, "-80", "2026-10-19", { source: "manual" });
  const b = await entry(f.bank, "80");
  await entry(f.broker, "80");
  expect(await accountBalance(h.db, f.ownerId, f.expense.id, "2026-10-25")).toBe("80.0000");
  expect(await accountBalance(h.db, f.ownerId, f.income.id, "2026-10-25")).toBe("-160.0000");
  const result = await resolve(a, b, "confirm");
  expect(await suggestions()).toEqual([]);
  const linked = (await current()).filter((row) => row.transferMatchId === result.transferMatchId);
  expect(linked).toHaveLength(2);
  expect(linked.map((row) => row.replacesEntryId).sort()).toEqual([a.id, b.id].sort());
  expect(linked.map((row) => row.source).sort()).toEqual(["import", "manual"]);
  expect(linked.map((row) => row.eventDate).sort()).toEqual(["2026-10-19", "2026-10-22"]);
  for (const row of linked) {
    expect(row.entryType).toBe("transfer");
    const detail = await getEntry(h.db, f.ownerId, row.id);
    const clearingAccount = await getSystemAccount(h.db, f.ownerId, "transfer_clearing", "USD");
    expect(detail.postings.some((line) => line.accountId === clearingAccount.id)).toBe(true);
  }
  expect((await getEntry(h.db, f.ownerId, a.id)).status).toBe("voided");
  expect((await getEntry(h.db, f.ownerId, b.id)).status).toBe("voided");
  expect(await accountBalance(h.db, f.ownerId, f.expense.id, "2026-10-25")).toBe("0.0000");
  expect(await accountBalance(h.db, f.ownerId, f.income.id, "2026-10-25")).toBe("-80.0000");
  await expect(resolve(a, b, "confirm")).rejects.toMatchObject({
    status: 404,
    message: "建议已失效，请刷新",
  });
  const audit = await h.db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.action, "transfer.suggestion_confirmed"));
  expect(audit.map((row) => row.entityId).sort()).toEqual([a.id, b.id].sort());
  expect(audit.every((row) => Object.keys(row.changes).length === 0)).toBe(true);
});
it("rejects without ledger changes, leaves other suggestions, and remembers either side's replacement chain", async () => {
  const a = await entry(f.card, "-80");
  const b = await entry(f.bank, "80");
  const c = await entry(f.broker, "80");
  const before = await current();
  const lines = await h.db.select().from(postings);
  await resolve(b, a);
  expect(await current()).toEqual(before);
  expect(await h.db.select().from(postings)).toEqual(lines);
  expect(await h.db.select().from(transferPairRejections)).toHaveLength(1);
  expect(await suggestions()).toHaveLength(1);
  let replacement = a;
  for (let i = 0; i < 2; i++)
    replacement = await replaceEntry(
      h.db,
      f.ownerId,
      replacement.id,
      await input(f.card, "-80"),
      "Synthetic reclassification",
    );
  await replaceEntry(h.db, f.ownerId, b.id, await input(f.bank, "80"), "Synthetic reclassification");
  const pairs = await suggestions();
  expect(pairs).toHaveLength(1);
  expect([pairs[0].left.id, pairs[0].right.id].sort()).toEqual([replacement.id, c.id].sort());
  const audit = await h.db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.action, "transfer.suggestion_rejected"));
  expect(audit.map((row) => row.entityId).sort()).toEqual([a.id, b.id].sort());
  expect(audit.every((row) => Object.keys(row.changes).length === 0)).toBe(true);
});
it.each(["entry", "evidence"])(
  "retains provider rejection keys from %s through replacement and reset-style re-import",
  async (source) => {
    const a = await entry(f.card, "-80");
    const b = await entry(f.bank, "80");
    const ids = [a.id, b.id];
    for (const [original, account, providerId] of [
      [a, f.card, "synthetic-charge"],
      [b, f.bank, "synthetic-deposit"],
    ] as const) {
      if (source === "entry")
        await h.db
          .update(journalEntries)
          .set({ providerAccountId: account.id, providerTransactionId: providerId })
          .where(eq(journalEntries.id, original.id));
      else await automatic(original, account, providerId);
    }
    const key = (await suggestions())[0].key;
    await resolve(a, b);
    const replacement = await replaceEntry(
      h.db,
      f.ownerId,
      a.id,
      await input(f.card, "-80"),
      "Synthetic reclassification",
    );
    ids.push(replacement.id);
    expect(await suggestions()).toEqual([]);
    const loaded = await matchPool.loadMatchPool(h.db, f.ownerId);
    expect(computeTransferSuggestions({ ...loaded, rejectedPairs: new Set() })[0].key).toBe(key);
    await h.db.delete(importRows).where(eq(importRows.ownerId, f.ownerId));
    await h.db.delete(postings).where(inArray(postings.journalEntryId, ids));
    await h.db.delete(journalEntries).where(inArray(journalEntries.id, ids));
    const freshA = await entry(f.card, "-80");
    const freshB = await entry(f.bank, "80");
    await automatic(freshA, f.card, "synthetic-charge");
    await automatic(freshB, f.bank, "synthetic-deposit");
    expect(await suggestions()).toEqual([]);
    const exported = await exportOwnerData(h.db, f.ownerId);
    expect(exported.tables.transfer_pair_rejections).toHaveLength(1);
    expect((await exportOwnerData(h.db, f.otherId)).tables.transfer_pair_rejections).toEqual([]);
    expect(ownerTables.transfer_pair_rejections).toBe(transferPairRejections);
  },
);
it("excludes rejected strong edges before scoring and preserves competing edges for mutual uniqueness", async () => {
  const a = await entry(f.bank, "-80", undefined, { description: "ACH PMT" });
  const b = await entry(f.card, "80", undefined, { description: "PAYMENT THANK YOU" });
  const c = await entry(f.broker, "80", undefined, { description: "ACH PMT" });
  const d = await entry(f.bank, "-80", undefined, { description: "ACH PMT" });
  for (const [original, account] of [
    [a, f.bank],
    [b, f.card],
    [c, f.broker],
    [d, f.bank],
  ] as const)
    await automatic(original, account, `synthetic-${original.id}`);
  await resolve(a, b);
  expect(await matchUniqueLegs(h.db, f.ownerId, "sandbox")).toBe(0);
  expect((await current()).every((row) => !row.transferMatchId)).toBe(true);
  await voidEntry(h.db, f.ownerId, d.id, "Synthetic competing candidate removed");
  expect(await matchUniqueLegs(h.db, f.ownerId, "sandbox", { changedEntryIds: new Set([a.id, c.id]) })).toBe(
    1,
  );
  expect((await getEntry(h.db, f.ownerId, b.id)).transferMatchId).toBeNull();
  const linked = (await current()).filter((row) => row.transferMatchId);
  expect(linked.map((row) => row.replacesEntryId).sort()).toEqual([a.id, c.id].sort());
});
it("also checks rejection keys for new unposted Plaid candidates", async () => {
  const a = await entry(f.bank, "-80", undefined, { description: "ACH PMT" });
  const b = await entry(f.card, "80", undefined, { description: "PAYMENT THANK YOU" });
  await automatic(a, f.bank, "synthetic-out");
  const row = await automatic(b, f.card, "synthetic-in");
  await resolve(a, b);
  await h.db
    .update(importRows)
    .set({ journalEntryId: null, autoPostState: "none", decision: "pending" })
    .where(eq(importRows.id, row.id));
  await voidEntry(h.db, f.ownerId, b.id, "Synthetic upstream replacement");
  const [freshRow] = await h.db.select().from(importRows).where(eq(importRows.id, row.id));
  expect(await matchUniqueLegs(h.db, f.ownerId, "sandbox", { rows: [freshRow] })).toBe(0);
});
it("keeps identical provider IDs on different accounts distinct and rejects just that pair", async () => {
  const a = await entry(f.card, "-80");
  const b = await entry(f.bank, "80");
  await automatic(a, f.card, "shared-synthetic-provider-id");
  await automatic(b, f.bank, "shared-synthetic-provider-id");
  const loaded = await matchPool.loadMatchPool(h.db, f.ownerId);
  expect(new Set(loaded.pool.map((leg) => leg.legKey)).size).toBe(2);
  expect(computeTransferSuggestions(loaded)).toHaveLength(1);
  expect(
    computeTransferSuggestions({
      ...loaded,
      pool: loaded.pool.map((leg) => ({ ...leg, legKey: "entry:same-synthetic-identity" })),
    }),
  ).toEqual([]);
  await resolve(a, b);
  expect(await suggestions()).toEqual([]);
  const [rejection] = await h.db.select().from(transferPairRejections);
  expect(rejection.leftKey < rejection.rightKey).toBe(true);
});
it.each(["entry", "evidence"])(
  "keeps the original provider account from %s when replacement corrects the posting account",
  async (source) => {
    const a = await entry(f.card, "-80");
    const b = await entry(f.bank, "80");
    if (source === "entry")
      await h.db
        .update(journalEntries)
        .set({ providerAccountId: f.card.id, providerTransactionId: "synthetic-original-card" })
        .where(eq(journalEntries.id, a.id));
    else await automatic(a, f.card, "synthetic-original-card");
    const key = (await suggestions())[0].key;
    await resolve(a, b);
    await replaceEntry(
      h.db,
      f.ownerId,
      a.id,
      await input(f.broker, "-80"),
      "Synthetic posting account correction",
    );
    expect(await suggestions()).toEqual([]);
    const loaded = await matchPool.loadMatchPool(h.db, f.ownerId);
    expect(computeTransferSuggestions({ ...loaded, rejectedPairs: new Set() })[0].key).toBe(key);
  },
);
it("uses CSV linked evidence for provider identity and keeps explicit manual matching available after rejection", async () => {
  const a = await entry(f.card, "-80");
  const b = await entry(f.bank, "80");
  const row = await automatic(a, f.card, "synthetic-csv-provider");
  await h.db
    .update(importRows)
    .set({ source: "csv", journalEntryId: null, linkedEntryId: a.id })
    .where(eq(importRows.id, row.id));
  const loaded = await matchPool.loadMatchPool(h.db, f.ownerId);
  expect(loaded.pool.find((leg) => leg.id === a.id)!.legKey).toBe(`ptx:${f.card.id}:synthetic-csv-provider`);
  await resolve(a, b);
  const { entryMatching, resolveEntryMatching } = await import("@/lib/bank-sync/matching");
  expect((await entryMatching(h.db, f.ownerId, a.id)).candidates.map((leg) => leg.id)).toContain(b.id);
  await resolveEntryMatching(h.db, f.ownerId, a.id, { action: "match", counterpartEntryId: b.id });
  expect((await current()).every((record) => record.transferMatchId)).toBe(true);
});
it("rejects mixed-case provider IDs under the same provider account once after an account correction", async () => {
  const a = await entry(f.bank, "-80");
  const original = await entry(f.bank, "80");
  for (const [record, providerId] of [
    [a, "aZ1"],
    [original, "Ab2"],
  ] as const) {
    await h.db
      .update(journalEntries)
      .set({ providerAccountId: f.bank.id, providerTransactionId: providerId })
      .where(and(eq(journalEntries.ownerId, f.ownerId), eq(journalEntries.id, record.id)));
  }
  const b = await replaceEntry(
    h.db,
    f.ownerId,
    original.id,
    await input(f.broker, "80"),
    "Synthetic posting account correction",
  );
  expect(await suggestions()).toHaveLength(1);
  await expect(resolve(a, b)).resolves.toEqual({ transferMatchId: null });
  const rejections = await h.db
    .select()
    .from(transferPairRejections)
    .where(eq(transferPairRejections.ownerId, f.ownerId));
  expect(rejections).toHaveLength(1);
  expect(rejections[0]).toMatchObject({ leftKey: `ptx:${f.bank.id}:Ab2`, rightKey: `ptx:${f.bank.id}:aZ1` });
  expect(await suggestions()).toEqual([]);
  await expect(resolve(b, a)).rejects.toMatchObject({ status: 404, message: "建议已失效，请刷新" });
  expect(
    await h.db.select().from(transferPairRejections).where(eq(transferPairRejections.ownerId, f.ownerId)),
  ).toEqual(rejections);
  // PGlite uses C collation: ensure migrations cannot reintroduce a locale-dependent CHECK.
  const checks = await h.client.query(
    "select conname from pg_constraint where conrelid = 'transfer_pair_rejections'::regclass and contype = 'c'",
  );
  expect(checks.rows).toEqual([]);
});
it("exports and deletes rejection memory only for the owner, with unique pair constraints", async () => {
  const a = await entry(f.card, "-80");
  const b = await entry(f.bank, "80");
  await resolve(a, b);
  const [rejection] = await h.db.select().from(transferPairRejections);
  const keys = { leftKey: rejection.leftKey, rightKey: rejection.rightKey };
  await expect(h.db.insert(transferPairRejections).values({ ownerId: f.ownerId, ...keys })).rejects.toThrow();
  await h.db.insert(transferPairRejections).values({ ownerId: f.otherId, ...keys });
  const password = "Synthetic-Delete-Password-2026";
  await h.db
    .update(users)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(users.id, f.ownerId));
  const dir = await mkdtemp(join(tmpdir(), "transfer-suggestions-"));
  try {
    await deleteOwnerData(
      h.db,
      f.ownerId,
      { confirmation: DELETE_CONFIRMATION, password },
      {
        APP_SECRET: "synthetic-transfer-suggestions-secret-32",
        DATA_DIR: dir,
      },
    );
    expect(await h.db.select().from(transferPairRejections)).toMatchObject([{ ownerId: f.otherId, ...keys }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("shares one pool for workbench/count and allows confirmation across environment boundaries", async () => {
  const a = await entry(f.card, "-80");
  const b = await entry(f.bank, "80");
  await automatic(a, f.card, "synthetic-production", "production");
  const spy = vi.spyOn(matchPool, "loadMatchPool");
  const data = await pendingWorkbench(h.db, f.ownerId, "sandbox");
  expect(spy).toHaveBeenCalledTimes(1);
  expect(data.count).toBe(1);
  expect(data.suggestions).toHaveLength(1);
  spy.mockClear();
  expect(await pendingCount(h.db, f.ownerId, "sandbox")).toBe(1);
  expect(spy).toHaveBeenCalledTimes(1);
  await resolve(a, b, "confirm");
  expect(await suggestions()).toEqual([]);
});
it("enforces owner isolation, stale pairs, strict input and API auth/origin with Plaid disabled", async () => {
  const a = await entry(f.card, "-80");
  const b = await entry(f.bank, "80");
  for (const action of ["confirm", "reject"] as const)
    await expect(resolve(a, b, action, f.otherId)).rejects.toMatchObject({ status: 404 });
  expect(await transferSuggestions(h.db, f.otherId)).toEqual([]);
  const session = await createSession(h.db, f.ownerId, { ipHash: "synthetic", userAgent: "test" });
  const other = await createSession(h.db, f.otherId, { ipHash: "synthetic", userAgent: "test" });
  const body = { action: "reject", entryId: a.id, counterpartEntryId: b.id };
  const request = (method: string, token?: string, data: unknown = body, origin = "http://localhost:3000") =>
    new NextRequest("http://localhost:3000/api/transfer-suggestions", {
      method,
      headers: {
        "content-type": "application/json",
        host: "localhost:3000",
        origin,
        ...(token ? { cookie: `al_session=${token}` } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(data) } : {}),
    });
  expect((await route.GET(request("GET"))).status).toBe(401);
  expect((await route.POST(request("POST"))).status).toBe(401);
  expect(await (await route.GET(request("GET", other.token))).json()).toEqual([]);
  expect((await route.POST(request("POST", other.token))).status).toBe(404);
  expect((await route.POST(request("POST", session.token, body, "https://untrusted.example"))).status).toBe(
    403,
  );
  for (const invalid of [
    { ...body, ownerId: f.otherId },
    { ...body, action: "match" },
    { ...body, entryId: "bad" },
    { action: "confirm" },
  ])
    expect((await route.POST(request("POST", session.token, invalid))).status).toBe(400);
  expect(await (await route.GET(request("GET", session.token))).json()).toHaveLength(1);
  expect((await route.POST(request("POST", session.token))).status).toBe(200);
  const stale = await route.POST(request("POST", session.token));
  expect(stale.status).toBe(404);
  expect(await stale.json()).toEqual({ error: "建议已失效，请刷新" });
  expect(await h.db.select().from(transferPairRejections)).toHaveLength(1);
  const c = await entry(f.broker, "80");
  await voidEntry(h.db, f.ownerId, c.id, "Synthetic stale pair");
  await expect(resolve(a, c, "confirm")).rejects.toMatchObject({ status: 404 });
});
it("renders the queue and navigation badge with Plaid disabled, with stackable rows and nowrap amounts", async () => {
  await entry(f.card, "-80", "2026-10-19");
  await entry(f.bank, "80");
  await entry(f.broker, "80");
  const pairs = await suggestions();
  const html = renderToStaticMarkup(<TransferSuggestions items={pairs} />);
  for (const text of [
    "可能的转账（2）",
    "相差 3 天",
    "另有 1 个候选",
    "是转账",
    "不是",
    "sm:grid-cols-2",
    "whitespace-nowrap",
  ])
    expect(html).toContain(text);
  expect(html).not.toContain("dialog");
  const page = renderToStaticMarkup(await StatementsPage({ searchParams: Promise.resolve({}) }));
  expect(page).toContain("可能的转账（2）");
  expect(page).not.toContain("最近自动入账");
  expect(renderToStaticMarkup(<AppNavigation plaidEnabled={false} pendingCount={pairs.length} />)).toContain(
    "2 项待处理",
  );
});
