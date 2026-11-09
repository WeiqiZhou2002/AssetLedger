import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Children, isValidElement, useId, useState, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as s from "@/db/schema";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { FakePlaid, bankAccount, bankTransaction, plaidConfig } from "./helpers/plaid";
import {
  connectionAccounts,
  exchangeConnection,
  removeConnection,
  requireConnection,
  saveMapping,
  storeAccounts,
} from "@/lib/bank-sync/connections";
import { syncConnection } from "@/lib/bank-sync/sync";
import {
  applyPendingTransactions,
  deletePendingForBankAccounts,
  deletePendingForConnection,
  listPendingTransactions,
  pendingCountsByAccount,
  pendingInScope,
  pendingSectionVisible,
} from "@/lib/bank-sync/pending-transactions";
import { pendingCount, pendingWorkbench, setAutoPost } from "@/lib/bank-sync/pending";
import { transferSuggestions } from "@/lib/bank-sync/transfer-suggestions";
import { executeReset, planReset } from "@/lib/bank-sync/reset";
import { deleteOwnerData, DELETE_CONFIRMATION } from "@/lib/data/delete";
import { exportOwnerData } from "@/lib/data/export";
import { exportTableNames } from "@/lib/data/tables";
import { hashPassword } from "@/lib/auth/password";
import { createAccount } from "@/lib/ledger/accounts";
import { createQuickEntry } from "@/lib/ledger/builders";
import { ledgerOverview } from "@/lib/ledger/queries";
import { monthSummary } from "@/lib/dashboard/month";
import { wealthOverview } from "@/lib/dashboard/wealth";
import { ActivityView } from "@/components/ledger/activity-view";
import { PendingTransactionsSection } from "@/components/ledger/pending-transactions";
import type { EntryFilters } from "@/lib/ledger/schemas";
import type { BankTransaction, SyncPage } from "@/lib/bank-sync/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: vi.fn(actual.useState), useId: vi.fn(actual.useId) };
});
const realReact = await vi.importActual<typeof import("react")>("react");
let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
let dir: string;
const now = new Date("2026-10-24T12:00:00Z");
const today = "2026-10-24";
const config = plaidConfig;
beforeAll(async () => {
  h = await createTestDb();
  dir = await mkdtemp(join(tmpdir(), "synthetic-pending-"));
});
afterAll(async () => {
  await h.client.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
});
async function connect(accountId = f.bank.id, ownerId = f.ownerId, autoPost = true) {
  const client = new FakePlaid();
  client.item.id = `item-${accountId}`;
  client.accountRows = [bankAccount("bank", accountId === f.card.id ? "credit" : "depository")];
  const result = await exchangeConnection(
    h.db,
    ownerId,
    client,
    config,
    {
      public_token: "synthetic",
      institution: { institution_id: `ins_${accountId}`, name: "Example Bank" },
    },
    now,
  );
  await saveMapping(
    h.db,
    ownerId,
    result.connection.id,
    config,
    {
      importFromDate: "2026-10-01",
      accounts: [{ id: result.accounts[0].id, accountId }],
    },
    now,
  );
  if (!autoPost) await setAutoPost(h.db, ownerId, result.connection.id, config, { autoPost: false });
  return { id: result.connection.id, mappingId: result.accounts[0].id, accountId, ownerId, client };
}
type Connection = Awaited<ReturnType<typeof connect>>;
const pendingTransaction = (id: string, changes: Partial<BankTransaction> = {}) =>
  bankTransaction(id, { pending: true, ...changes });
function page(c: Connection, added: BankTransaction[] = [], changes: Partial<SyncPage> = {}): SyncPage {
  return {
    accounts: c.client.accountRows,
    added,
    modified: [],
    removed: [],
    nextCursor: "cursor-done",
    hasMore: false,
    updateStatus: "HISTORICAL_UPDATE_COMPLETE",
    ...changes,
  };
}
async function sync(c: Connection, added: BankTransaction[] = [], changes: Partial<SyncPage> = {}) {
  c.client.page = () => page(c, added, changes);
  return syncConnection(h.db, c.ownerId, c.id, c.client, config, now);
}
const rows = () =>
  h.db.select().from(s.plaidPendingTransactions).orderBy(s.plaidPendingTransactions.providerTransactionId);
async function apply(c: Connection, added: BankTransaction[], changes: Partial<SyncPage> = {}) {
  return h.db.transaction(async (tx) =>
    applyPendingTransactions(
      tx,
      c.ownerId,
      await requireConnection(tx, c.ownerId, c.id),
      page(c, added, changes),
      await connectionAccounts(tx, c.ownerId, c.id),
      now,
    ),
  );
}

it("stores only in-scope masked decimal pending rows, counts skips, and creates no ledger/import rows", async () => {
  const c = await connect();
  c.client.accountRows.push(
    bankAccount("loan", "loan"),
    bankAccount("investment", "investment"),
    bankAccount("unmapped"),
    bankAccount("disabled"),
  );
  await storeAccounts(h.db, f.ownerId, c.id, c.client.accountRows, now);
  const inputs = [
    pendingTransaction("valid", {
      amount: "123.4567",
      merchantName: "Example 1234567890",
      originalDescription: "Example order 9876543210",
    }),
    ...["loan", "investment", "unmapped", "disabled", "missing"].map((accountId) =>
      pendingTransaction(accountId, { accountId }),
    ),
    pendingTransaction("currency", { currency: "CNY" }),
    pendingTransaction("no-currency", { currency: null }),
    pendingTransaction("before-start", { date: "2026-09-30" }),
    pendingTransaction("core-sweep", { name: "REDEMPTION FROM CORE ACCOUNT (SPAXX)" }),
  ];
  const result = await sync(c, inputs);
  expect(result).toMatchObject({ pendingSkipped: inputs.length - 1, loanTransactionsSkipped: 1, added: 0 });
  expect(await rows()).toEqual([
    expect.objectContaining({
      providerTransactionId: "valid",
      amount: "-123.4567",
      transactionDate: "2026-10-21",
      merchant: "Example ******7890",
      description: "Example order ******3210",
    }),
  ]);
  for (const table of [s.importRows, s.journalEntries, s.postings])
    expect(await h.db.select().from(table)).toEqual([]);
  const [mapping] = await connectionAccounts(h.db, f.ownerId, c.id);
  const connection = await requireConnection(h.db, f.ownerId, c.id);
  expect(pendingInScope(inputs[0], { ...mapping, unsharedAt: now }, connection)).toBe(false);
  expect(pendingInScope(inputs[0], { ...mapping, importFromDate: "2026-10-23" }, connection)).toBe(false);
  expect(pendingInScope(inputs[0], { ...mapping, type: "loan", isEnabled: true }, connection)).toBe(false);
  expect(pendingInScope(inputs[0], { ...mapping, type: "investment", isEnabled: true }, connection)).toBe(
    false,
  );
  expect(pendingInScope(inputs[0], { ...mapping, isEnabled: false }, connection)).toBe(false);
  expect(pendingInScope(inputs[0], { ...mapping, accountId: null }, connection)).toBe(false);
});

it("updates modified pending rows and keeps replays idempotent", async () => {
  const c = await connect();
  await sync(c, [pendingTransaction("one")]);
  const first = (await rows())[0];
  const changed = pendingTransaction("one", {
    amount: "-21.1357",
    merchantName: "Example Updated",
    authorizedDate: null,
  });
  await sync(c, [], { modified: [changed] });
  await sync(c, [], { modified: [changed] });
  expect(await rows()).toEqual([
    expect.objectContaining({
      id: first.id,
      amount: "21.1357",
      merchant: "Example Updated",
      transactionDate: "2026-10-22",
    }),
  ]);
});

it.each([true, false])(
  "removes posted counterparts and imports only the posted row with autoPost=%s",
  async (autoPost) => {
    const c = await connect(f.bank.id, f.ownerId, autoPost);
    await sync(c, [pendingTransaction("pending")]);
    await sync(c, [bankTransaction("posted", { pendingTransactionId: "pending" })]);
    expect(await rows()).toEqual([]);
    expect(await h.db.select().from(s.importRows)).toEqual([
      expect.objectContaining({ providerTransactionId: "posted", amount: "-20.0000" }),
    ]);
    expect(await h.db.select().from(s.journalEntries)).toHaveLength(autoPost ? 1 : 0);
    // Existing import rows keep their upstream review path, never become display-only pending.
    await sync(c, [], { modified: [pendingTransaction("posted")] });
    expect(await rows()).toEqual([]);
    expect(await h.db.select().from(s.importRows)).toHaveLength(1);
  },
);

it("removes upstream ids, same-batch adds, and counterparts of skipped posted transactions", async () => {
  const c = await connect();
  await sync(c, [pendingTransaction("removed"), pendingTransaction("skipped")]);
  await sync(c, [pendingTransaction("same-batch")], {
    removed: ["removed", "same-batch"],
    modified: [
      bankTransaction("posted-before-start", { date: "2026-09-30", pendingTransactionId: "skipped" }),
    ],
  });
  expect(await rows()).toEqual([]);
  expect(await h.db.select().from(s.importRows)).toEqual([]);
});

it("replaces the full pending set when enabling another mapping resets the cursor", async () => {
  const c = await connect();
  await sync(c, [pendingTransaction("stale"), pendingTransaction("retained")]);
  c.client.accountRows.push(bankAccount("new-card", "credit"));
  await storeAccounts(h.db, f.ownerId, c.id, c.client.accountRows, now);
  const mapping = (await connectionAccounts(h.db, f.ownerId, c.id)).find(
    (row) => row.plaidAccountId === "new-card",
  )!;
  await saveMapping(
    h.db,
    f.ownerId,
    c.id,
    config,
    { importFromDate: "2026-10-01", accounts: [{ id: mapping.id, accountId: f.card.id }] },
    now,
  );
  expect((await requireConnection(h.db, f.ownerId, c.id)).transactionsCursor).toBeNull();
  await sync(c, [pendingTransaction("retained"), pendingTransaction("new", { accountId: "new-card" })]);
  expect((await rows()).map((row) => row.providerTransactionId)).toEqual(["new", "retained"]);
  await h.db
    .update(s.bankConnections)
    .set({ transactionsCursor: null })
    .where(eq(s.bankConnections.id, c.id));
  await sync(c);
  expect(await rows()).toEqual([]);
});

it("prunes out-of-scope modifications and stale disabled, unmapped, unshared or mismatched mappings", async () => {
  const c = await connect();
  await sync(c, [pendingTransaction("one")]);
  await sync(c, [], { modified: [pendingTransaction("one", { currency: null })] });
  expect(await rows()).toEqual([]);
  for (const change of [
    { isEnabled: false },
    { accountId: null },
    { unsharedAt: now },
    { currency: "CNY" },
    { type: "loan" },
    { type: "investment" },
  ]) {
    await h.db
      .update(s.bankConnectionAccounts)
      .set({ isEnabled: true, accountId: f.bank.id, unsharedAt: null, currency: "USD", type: "depository" })
      .where(eq(s.bankConnectionAccounts.id, c.mappingId));
    await apply(c, [pendingTransaction("one")]);
    await h.db
      .update(s.bankConnectionAccounts)
      .set(change)
      .where(eq(s.bankConnectionAccounts.id, c.mappingId));
    expect(await apply(c, [])).toMatchObject({ stored: 0, removed: 1 });
    expect(await rows()).toEqual([]);
  }
});

it("cleans mapping disables and connection removal in their existing transactions", async () => {
  const c = await connect();
  await sync(c, [pendingTransaction("one")]);
  await saveMapping(
    h.db,
    f.ownerId,
    c.id,
    config,
    { importFromDate: "2026-10-01", accounts: [{ id: c.mappingId, accountId: f.bank.id, isEnabled: false }] },
    now,
  );
  expect(await rows()).toEqual([]);
  await saveMapping(
    h.db,
    f.ownerId,
    c.id,
    config,
    { importFromDate: "2026-10-01", accounts: [{ id: c.mappingId, accountId: f.bank.id, isEnabled: true }] },
    now,
  );
  await sync(c, [pendingTransaction("one")]);
  await removeConnection(h.db, f.ownerId, c.id, c.client, config);
  expect(await rows()).toEqual([]);
});

it("resets only selected connections, without pending preview counts or recovery entries", async () => {
  const c = await connect();
  const other = await connect(f.card.id);
  await sync(c, [pendingTransaction("selected")]);
  await sync(other, [pendingTransaction("survives")]);
  const resetConfig = { ...config, DATA_DIR: dir, FILE_RETENTION_DAYS: 30 };
  const input = { connections: [c.id], from: "2026-10-01" };
  const preview = await planReset(h.db, f.ownerId, resetConfig, input, now);
  expect(preview.totals).toMatchObject({ entries_deleted: 0, postings_deleted: 0, rows_deleted: 0 });
  await executeReset(h.db, f.ownerId, resetConfig, input, now);
  expect((await rows()).map((row) => row.providerTransactionId)).toEqual(["survives"]);
});

it("exports the table and deletes owned pending before its FK parents, leaving another owner's rows", async () => {
  const c = await connect();
  const otherAccount = await createAccount(h.db, f.otherId, {
    name: "Other Example Checking",
    type: "asset_cash",
    currency: "USD",
  });
  const other = await connect(otherAccount.id, f.otherId);
  await sync(c, [pendingTransaction("owned")]);
  await sync(other, [pendingTransaction("foreign")]);
  await deletePendingForConnection(h.db, f.otherId, c.id);
  await deletePendingForBankAccounts(h.db, f.otherId, c.id, ["bank"]);
  await deletePendingForBankAccounts(h.db, f.ownerId, c.id, []);
  expect(await rows()).toHaveLength(2);
  expect(exportTableNames).toContain("plaid_pending_transactions");
  const exported = await exportOwnerData(h.db, f.ownerId);
  expect(exported.tables.plaid_pending_transactions).toEqual([
    expect.objectContaining({ providerTransactionId: "owned" }),
  ]);
  const password = "Synthetic-Pending-Delete-2026";
  await h.db
    .update(s.users)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(s.users.id, f.ownerId));
  // Exercise allowlist deletion even for rows on an already-revoked connection.
  await h.db.update(s.bankConnections).set({ status: "revoked" }).where(eq(s.bankConnections.id, c.id));
  await deleteOwnerData(
    h.db,
    f.ownerId,
    { password, confirmation: DELETE_CONFIRMATION },
    { ...config, DATA_DIR: dir },
    now,
    c.client,
  );
  expect((await rows()).map((row) => row.providerTransactionId)).toEqual(["foreign"]);
});

it("lists only eligible owner/environment/account rows and applies escaped text/date/absolute-money filters", async () => {
  const c = await connect();
  const card = await connect(f.card.id);
  const otherAccount = await createAccount(h.db, f.otherId, {
    name: "Other Example Checking",
    type: "asset_cash",
    currency: "USD",
  });
  const other = await connect(otherAccount.id, f.otherId);
  await sync(c, [
    pendingTransaction("out", {
      amount: "25.5001",
      merchantName: "Example 50%_sale\\",
      authorizedDate: "2026-10-20",
    }),
    pendingTransaction("in", {
      amount: "-10.0001",
      merchantName: "Other Example",
      originalDescription: "Description needle",
      authorizedDate: "2026-10-22",
    }),
  ]);
  await sync(card, [pendingTransaction("card", { amount: "3" })]);
  await sync(other, [pendingTransaction("foreign")]);
  const list = (filters: Parameters<typeof listPendingTransactions>[3] = {}) =>
    listPendingTransactions(h.db, f.ownerId, "sandbox", filters);
  expect((await list()).total).toBe(3);
  expect(await pendingCountsByAccount(h.db, f.ownerId, "sandbox")).toEqual({
    [f.bank.id]: 2,
    [f.card.id]: 1,
  });
  for (const [filters, expected] of [
    [{ accountId: f.bank.id }, 2],
    [{ accountId: otherAccount.id }, 0],
    [{ currency: "CNY" }, 0],
    [{ merchant: "%_" }, 1],
    [{ merchant: "\\" }, 1],
    [{ merchant: "NEEDLE" }, 1],
    [{ from: "2026-10-21", to: "2026-10-22", accountId: f.bank.id }, 1],
    [{ minAmount: "10.0001", maxAmount: "25.5001", accountId: f.bank.id }, 2],
    [{ minAmount: "10.0002", maxAmount: "25.5000" }, 0],
    [{ minAmount: "0", maxAmount: "0" }, 0],
  ] as const)
    expect((await list(filters)).total).toBe(expected);
  for (const status of ["login_required", "revoked", "error"] as const) {
    await h.db.update(s.bankConnections).set({ status }).where(eq(s.bankConnections.id, c.id));
    expect((await list()).total).toBe(1);
    expect(await pendingCountsByAccount(h.db, f.ownerId, "sandbox")).toEqual({ [f.card.id]: 1 });
  }
  await h.db
    .update(s.bankConnections)
    .set({ status: "consent_expiring", environment: "production" })
    .where(eq(s.bankConnections.id, c.id));
  expect((await list()).total).toBe(1);
  expect((await listPendingTransactions(h.db, f.ownerId, "production")).total).toBe(2);
  await h.db.update(s.bankConnections).set({ environment: "sandbox" }).where(eq(s.bankConnections.id, c.id));
  for (const change of [
    { isEnabled: false },
    { unsharedAt: now },
    { accountId: null },
    { currency: "CNY" },
    { type: "loan" },
    { type: "investment" },
  ]) {
    await h.db
      .update(s.bankConnectionAccounts)
      .set(change)
      .where(eq(s.bankConnectionAccounts.id, c.mappingId));
    expect((await list()).total).toBe(1);
    await h.db
      .update(s.bankConnectionAccounts)
      .set({ isEnabled: true, unsharedAt: null, accountId: f.bank.id, currency: "USD", type: "depository" })
      .where(eq(s.bankConnectionAccounts.id, c.mappingId));
  }
  for (const change of [{ isActive: false }, { currency: "CNY" }]) {
    await h.db.update(s.accounts).set(change).where(eq(s.accounts.id, f.bank.id));
    expect((await list()).total).toBe(1);
    await h.db
      .update(s.accounts)
      .set({ isActive: true, isSystem: false, currency: "USD" })
      .where(eq(s.accounts.id, f.bank.id));
  }
  await h.db
    .update(s.bankConnectionAccounts)
    .set({ accountId: f.expense.id })
    .where(eq(s.bankConnectionAccounts.id, c.mappingId));
  expect((await list()).total).toBe(1);
  await h.db
    .update(s.bankConnectionAccounts)
    .set({ accountId: f.bank.id })
    .where(eq(s.bankConnectionAccounts.id, c.mappingId));
  expect((await list()).total).toBe(3);
});

it("returns the full count but only the 200 latest rows with stable ordering", async () => {
  const c = await connect();
  await apply(
    c,
    Array.from({ length: 202 }, (_, index) =>
      pendingTransaction(`pending-${index}`, { authorizedDate: index === 0 ? "2026-10-01" : "2026-10-22" }),
    ),
  );
  const result = await listPendingTransactions(h.db, f.ownerId, "sandbox");
  expect(result.total).toBe(202);
  expect(result.rows).toHaveLength(200);
  expect(result.rows.every((row) => row.transactionDate === "2026-10-22")).toBe(true);
  expect(result.rows.map((row) => row.id)).toEqual(result.rows.map((row) => row.id).sort());
  expect(await pendingCountsByAccount(h.db, f.ownerId, "sandbox")).toEqual({ [f.bank.id]: 202 });
});

it("leaves spending, income, overview, net worth, transfer suggestions and review counts unchanged", async () => {
  const c = await connect();
  await sync(c);
  await createQuickEntry(h.db, f.ownerId, {
    type: "expense",
    fromAccountId: f.bank.id,
    amount: "23",
    categoryId: f.category("购物"),
    eventDate: today,
  });
  await createQuickEntry(h.db, f.ownerId, {
    type: "income",
    toAccountId: f.bank.id,
    amount: "120",
    categoryId: f.category("工资"),
    eventDate: today,
  });
  const read = () =>
    Promise.all([
      ledgerOverview(h.db, f.ownerId, today, "posted"),
      monthSummary(h.db, f.ownerId, "2026-10", today, "posted", "USD", 7),
      wealthOverview(h.db, f.ownerId, today, "USD", 7, 7),
      pendingWorkbench(h.db, f.ownerId, "sandbox"),
      pendingCount(h.db, f.ownerId, "sandbox"),
      transferSuggestions(h.db, f.ownerId),
      h.db.select().from(s.snapshotItems),
      h.db.select().from(s.merchantCategoryMemory),
    ]);
  const before = await read();
  await apply(c, [
    pendingTransaction("out", { amount: "23", name: "TRANSFER TO EXAMPLE CARD" }),
    pendingTransaction("in", { amount: "-120", name: "EXAMPLE BENEFIT CREDIT" }),
  ]);
  expect(await rows()).toHaveLength(2);
  expect(await read()).toEqual(before);
});

it.each([
  [{}, true],
  [{ offset: 0 }, true],
  [{ offset: 1 }, false],
  [{ view: "all" }, true],
  [{ view: "cashflow" }, true],
  [{ view: "income" }, false],
  [{ view: "spending" }, false],
  [{ type: "expense" }, false],
  [{ categoryId: "category" }, false],
  [{ status: "confirmed" }, false],
  [{ status: "draft" }, false],
  [{ status: "voided" }, false],
  [{ accountId: "account", merchant: "Example", currency: "USD" }, true],
] satisfies [EntryFilters, boolean][])("pending section visibility for %j is %s", (filters, expected) => {
  expect(pendingSectionVisible(filters)).toBe(expected);
});

it("rejects a stale cursor without storing pending rows", async () => {
  const c = await connect();
  c.client.page = async () => {
    await h.db
      .update(s.bankConnections)
      .set({ transactionsCursor: "raced" })
      .where(eq(s.bankConnections.id, c.id));
    return page(c, [pendingTransaction("one")]);
  };
  await expect(syncConnection(h.db, f.ownerId, c.id, c.client, config, now)).rejects.toMatchObject({
    status: 409,
  });
  expect(await rows()).toEqual([]);
});

it("rolls back a pending upsert when a later sync write fails", async () => {
  const c = await connect();
  await h.db.execute(sql`create function synthetic_pending_failure() returns trigger as $$ begin
    if new.transactions_cursor is not null and exists (select 1 from plaid_pending_transactions where connection_id = new.id) then
      raise exception 'synthetic_after_pending_upsert';
    end if;
    return new;
  end; $$ language plpgsql`);
  await h.db.execute(
    sql`create trigger synthetic_pending_failure before update on bank_connections for each row execute function synthetic_pending_failure()`,
  );
  try {
    await expect(sync(c, [pendingTransaction("one")])).rejects.toMatchObject({
      cause: { message: "synthetic_after_pending_upsert" },
    });
    expect(await rows()).toEqual([]);
    expect((await requireConnection(h.db, f.ownerId, c.id)).transactionsCursor).toBeNull();
    expect(await h.db.select().from(s.statements)).toEqual([]);
  } finally {
    await h.db.execute(sql`drop trigger synthetic_pending_failure on bank_connections`);
    await h.db.execute(sql`drop function synthetic_pending_failure()`);
  }
});

it("renders a collapsed activity section and expands into account groups with signed flow labels", async () => {
  const c = await connect();
  const card = await connect(f.card.id);
  await sync(c, [pendingTransaction("out", { amount: "25.50" })]);
  await sync(card, [pendingTransaction("in", { amount: "-10" })]);
  const pending = await listPendingTransactions(h.db, f.ownerId, "sandbox");
  const props: ComponentProps<typeof ActivityView> = {
    pending,
    data: { entries: [], total: 0, limit: 50, offset: 0 },
    accounts: [],
    categories: [],
    groups: [],
    today,
    settings: { prepaymentMode: "asset", spendingDateBasis: "posted" },
    filters: {},
  };
  const html = renderToStaticMarkup(<ActivityView {...props} />);
  expect(html).toContain("待入账 · 2 笔");
  expect(html).toContain("未计入收支");
  expect(html).toContain('aria-expanded="false"');
  expect(html).toMatch(/id="[^"]+" hidden=""/);
  for (const empty of [null, { total: 0, rows: [] }]) {
    expect(renderToStaticMarkup(<ActivityView {...props} pending={empty} />)).not.toContain("待入账");
  }
  let expanded = false;
  const render = () => {
    vi.mocked(useState).mockImplementation(<S,>() => [
      expanded as S,
      (next: S | ((previous: S) => S)) => {
        expanded = Boolean(typeof next === "function" ? (next as (previous: S) => S)(expanded as S) : next);
      },
    ]);
    vi.mocked(useId).mockReturnValue("synthetic-pending-section");
    try {
      return PendingTransactionsSection({ pending });
    } finally {
      vi.mocked(useState).mockImplementation(realReact.useState);
      vi.mocked(useId).mockImplementation(realReact.useId);
    }
  };
  type Props = { children?: ReactNode; onClick?: () => void };
  const nodes = (tree: ReactNode): React.ReactElement<Props>[] =>
    Children.toArray(tree).flatMap((node) =>
      isValidElement<Props>(node) ? [node, ...nodes(node.props.children)] : [],
    );
  nodes(render()).find((node) => node.type === "button")!.props.onClick!();
  const opened = renderToStaticMarkup(render());
  expect(opened).toContain('aria-expanded="true"');
  expect(opened).not.toContain('hidden=""');
  expect(opened).toContain("Example Bank Checking · Example Bank");
  expect(opened).toContain("Demo Card 1234 · Example Bank");
  for (const text of ["流入", "流出", "+USD 10.00", "USD 25.50", "银行尚未入账，金额可能变化"])
    expect(opened).toContain(text);
  expect(opened).not.toContain("<a ");
  expect(opened.match(/<button /g)).toHaveLength(1);
  expect(renderToStaticMarkup(<PendingTransactionsSection pending={{ ...pending, total: 201 }} />)).toContain(
    "仅显示最近 200 笔",
  );
});
