import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { FakePlaid, bankAccount, bankTransaction, plaidConfig as config } from "./helpers/plaid";
import {
  accounts,
  institutions,
  importRows,
  journalEntries,
  auditLogs,
  statements,
  importJobs,
} from "@/db/schema";
import {
  exchangeConnection,
  saveMapping,
  listConnections,
  connectionAccounts,
} from "@/lib/bank-sync/connections";
import { syncConnection } from "@/lib/bank-sync/sync";
import { confirmOpeningBalance } from "@/lib/bank-sync/opening-balances";
import { setAutoPost } from "@/lib/bank-sync/pending";
import { createAccount, createInstitution, listAccounts, requireAccount } from "@/lib/ledger/accounts";
import { createQuickEntry } from "@/lib/ledger/builders";
import { voidEntry } from "@/lib/ledger/entries";
import { accountBalance } from "@/lib/ledger/queries";
import { approveRows } from "@/lib/imports/approval";
import { updateImportRows } from "@/lib/imports/review";
import { applyParsedStatement } from "@/lib/imports/processing";
import { getStatementReview, setStatementAccount } from "@/lib/imports/service";
import { createSession } from "@/lib/auth/session";
import { plaidLedgerType } from "@/lib/imports/account-defaults";
import { MappingForm } from "@/components/bank-sync/mapping-form";
import { jsonSafe } from "@/lib/serialization";

let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
let client: FakePlaid;
let token: string;
const now = new Date("2026-10-24T12:00:00Z");
vi.mock("@/db/client", () => ({ getDb: () => h.db }));
vi.mock("@/lib/auth/current-user", () => ({ requireUser: async () => ({ id: f.ownerId }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  permanentRedirect: (path: string) => {
    throw new Error(`PERMANENT:${path}`);
  },
}));
const hub = await import("@/app/(app)/statements/page");
const legacyPage = await import("@/app/(app)/settings/banks/page");
const assignmentRoute = await import("@/app/api/statements/[id]/route");
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
  client = new FakePlaid();
  token = (await createSession(h.db, f.ownerId, { ipHash: "synthetic", userAgent: "Test" })).token;
  vi.stubEnv("PLAID_ENABLED", "true");
});
async function connect() {
  return exchangeConnection(
    h.db,
    f.ownerId,
    client,
    config,
    {
      public_token: "public-sandbox-synthetic",
      institution: { institution_id: client.item.institutionId, name: client.item.institutionName },
      // Account-creation fixtures intentionally add another login at the same institution.
      allowDuplicate: true,
    },
    now,
  );
}
async function createMapped() {
  const result = await connect();
  // Opening suggestions remain independent of approval; keep these fixtures in review mode.
  await setAutoPost(h.db, f.ownerId, result.connection.id, config, { autoPost: false });
  await saveMapping(
    h.db,
    f.ownerId,
    result.connection.id,
    config,
    {
      importFromDate: "2026-10-01",
      accounts: result.accounts.map((row) => ({
        id: row.id,
        create: {
          name: `New ${row.name}`,
          type: plaidLedgerType(row.type),
          currency: row.currency,
        },
      })),
    },
    now,
  );
  return {
    id: result.connection.id,
    mapped: await connectionAccounts(h.db, f.ownerId, result.connection.id),
  };
}
function transactionPage(added: ReturnType<typeof bankTransaction>[]) {
  return {
    accounts: client.accountRows,
    added,
    modified: [],
    removed: [],
    nextCursor: "done",
    hasMore: false,
    updateStatus: "HISTORICAL_UPDATE_COMPLETE",
  };
}
async function pdf(last4 = "1234", issuer = "Example Bank") {
  const [statement] = await h.db
    .insert(statements)
    .values({
      ownerId: f.ownerId,
      originalFilename: "Synthetic.pdf",
      mime: "application/pdf",
      sizeBytes: 100,
      fileSha256: crypto.randomUUID().replaceAll("-", "").repeat(2),
    })
    .returning();
  await applyParsedStatement(h.db, f.ownerId, statement.id, {
    statement_type: "credit_card",
    account_last4: last4,
    issuer,
    currency: "USD",
    page_count: 1,
    parser: "synthetic",
    parser_version: "1",
    entries: [],
    summary: {},
    diagnostics: [],
    transaction_lines: [],
  });
  return getStatementReview(h.db, f.ownerId, statement.id);
}

it("creates each supported Plaid account type with defaults, tail digits, institution reuse and investment dual mapping", async () => {
  client.accountRows = [
    bankAccount("checking"),
    bankAccount("card", "credit"),
    bankAccount("loan", "loan"),
    bankAccount("invest", "investment"),
    { ...bankAccount("wallet"), currency: "CNY" },
  ];
  const { mapped } = await createMapped();
  expect(mapped).toHaveLength(5);
  for (const mapping of mapped) {
    const account = await requireAccount(h.db, f.ownerId, mapping.accountId!);
    expect(account).toMatchObject({
      type: plaidLedgerType(mapping.type),
      currency: mapping.currency,
      last4: "1234",
      financialInclusion: true,
      cashLikeInclusion: mapping.currency === "USD" && mapping.type !== "loan",
    });
    expect(mapping.accountCreatedHere).toBe(true);
    expect(await accountBalance(h.db, f.ownerId, account.id, "2026-10-24")).toBe("0.0000");
    if (mapping.type === "investment") {
      expect(await requireAccount(h.db, f.ownerId, mapping.securityAccountId!)).toMatchObject({
        name: `${account.name} 持仓`,
        type: "asset_security",
        cashLikeInclusion: false,
        financialInclusion: true,
        institutionId: account.institutionId,
      });
    }
  }
  const ownedInstitutions = await h.db.select().from(institutions).where(eq(institutions.ownerId, f.ownerId));
  expect(ownedInstitutions).toHaveLength(1);
  expect(ownedInstitutions[0]).toMatchObject({ plaidInstitutionId: client.item.institutionId, kind: "bank" });
  expect(
    (await h.db.select().from(auditLogs)).filter((row) => row.action === "bank.account_mapping"),
  ).toHaveLength(5);
  expect(await h.db.select().from(journalEntries)).toHaveLength(0);
});

it("suffixes occupied names per owner, honors inclusion overrides, and reuses institutions by provider ID or case-insensitive name", async () => {
  await createAccount(h.db, f.ownerId, { name: "Shared", type: "asset_cash", currency: "USD" });
  await createAccount(h.db, f.ownerId, { name: "Shared (2)", type: "asset_cash", currency: "USD" });
  const institution = await createInstitution(h.db, f.ownerId, { name: "eXaMpLe BaNk", kind: "bank" });
  const foreign = await createInstitution(h.db, f.otherId, { name: "Example Bank", kind: "bank" });
  const result = await connect();
  await saveMapping(
    h.db,
    f.ownerId,
    result.connection.id,
    config,
    {
      importFromDate: "2026-10-01",
      accounts: result.accounts.map((row) => ({
        id: row.id,
        create: {
          name: "Shared",
          type: plaidLedgerType(row.type),
          currency: "USD",
          cashLikeInclusion: false,
          financialInclusion: false,
        },
      })),
    },
    now,
  );
  const mapped = await connectionAccounts(h.db, f.ownerId, result.connection.id);
  const created = await Promise.all(mapped.map((row) => requireAccount(h.db, f.ownerId, row.accountId!)));
  expect(created.map((row) => row.name).sort()).toEqual(["Shared (3)", "Shared (4)"]);
  expect(
    created.every(
      (row) => row.institutionId === institution.id && !row.cashLikeInclusion && !row.financialInclusion,
    ),
  ).toBe(true);
  expect(
    (await h.db.select().from(institutions).where(eq(institutions.id, foreign.id)))[0].plaidInstitutionId,
  ).toBeNull();
  client.item.id = "item-2";
  client.item.institutionName = "Renamed Example Institution";
  client.accountRows = [bankAccount("another")];
  const second = await createMapped();
  expect((await requireAccount(h.db, f.ownerId, second.mapped[0].accountId!)).institutionId).toBe(
    institution.id,
  );
  expect(await h.db.select().from(institutions).where(eq(institutions.ownerId, f.ownerId))).toHaveLength(1);
});

it.each(["credit", "investment"])(
  "creates the institution kind appropriate to a new %s connection",
  async (type) => {
    client.accountRows = [bankAccount("only", type)];
    await createMapped();
    expect((await h.db.select().from(institutions))[0].kind).toBe(
      type === "credit" ? "card_issuer" : "brokerage",
    );
  },
);

it("rolls back accounts, institutions, mappings, audits and jobs if a later create has an incompatible currency", async () => {
  client.accountRows = [bankAccount("bank"), bankAccount("loan", "loan")];
  const result = await connect();
  const before = {
    accounts: await h.db.select().from(accounts),
    institutions: await h.db.select().from(institutions),
    audit: await h.db.select().from(auditLogs),
    jobs: await h.db.select().from(importJobs),
  };
  await expect(
    saveMapping(
      h.db,
      f.ownerId,
      result.connection.id,
      config,
      {
        importFromDate: "2026-10-01",
        accounts: result.accounts.map((row) => ({
          id: row.id,
          create: {
            name: `Rollback ${row.name}`,
            type: plaidLedgerType(row.type),
            currency: row.type === "loan" ? "CNY" : "USD",
          },
        })),
      },
      now,
    ),
  ).rejects.toThrow("账户类型或币种不兼容");
  expect(await h.db.select().from(accounts)).toEqual(before.accounts);
  expect(await h.db.select().from(institutions)).toEqual(before.institutions);
  expect(await h.db.select().from(auditLogs)).toEqual(before.audit);
  expect(await h.db.select().from(importJobs)).toEqual(before.jobs);
  expect(
    (await connectionAccounts(h.db, f.ownerId, result.connection.id)).every(
      (row) => !row.accountId && !row.accountCreatedHere,
    ),
  ).toBe(true);
});

it("rejects mixed existing/create inputs, invalid last4, mismatched currencies/types and another owner's mapping", async () => {
  const result = await connect();
  const bank = result.accounts[0];
  const input = {
    importFromDate: "2026-10-01",
    accounts: [{ id: bank.id, create: { name: "New", type: "asset_cash", currency: "USD" } }],
  };
  for (const changes of [
    { accountId: f.bank.id },
    { create: { ...input.accounts[0].create, last4: "12345678" } },
    { create: { ...input.accounts[0].create, currency: "CNY" } },
    { create: { ...input.accounts[0].create, type: "liability_loan" } },
  ])
    await expect(
      saveMapping(
        h.db,
        f.ownerId,
        result.connection.id,
        config,
        { ...input, accounts: [{ ...input.accounts[0], ...changes }] },
        now,
      ),
    ).rejects.toThrow();
  await expect(saveMapping(h.db, f.otherId, result.connection.id, config, input, now)).rejects.toThrow(
    "不存在",
  );
  expect(
    (await connectionAccounts(h.db, f.ownerId, result.connection.id)).every((row) => !row.accountId),
  ).toBe(true);
});

it("syncs into newly created accounts and later matches a PDF card statement by last4 and issuer", async () => {
  const { id, mapped } = await createMapped();
  client.page = () =>
    transactionPage([bankTransaction("bank"), bankTransaction("card", { accountId: "card" })]);
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  const rows = await h.db.select().from(importRows);
  expect(rows).toHaveLength(2);
  for (const row of rows)
    expect(row.accountId).toBe(
      mapped.find((account) => account.plaidAccountId === row.providerTransactionId)!.accountId,
    );
  expect((await pdf()).statement.accountId).toBe(mapped.find((row) => row.type === "credit")!.accountId);
});

it("waits for review then derives openings from confirmed postings; confirms exactly once", async () => {
  const { id, mapped } = await createMapped();
  expect(
    (await listConnections(h.db, f.ownerId))[0].accounts.every((row) => row.openingSuggestion === null),
  ).toBe(true);
  client.page = () =>
    transactionPage([
      bankTransaction("bank-spend"),
      bankTransaction("card-spend", { accountId: "card", amount: "30" }),
      bankTransaction("pending", { pending: true }),
      bankTransaction("unapproved", { amount: "40" }),
    ]);
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  const beforeApproval = (await listConnections(h.db, f.ownerId))[0].accounts.map(
    (row) => row.openingSuggestion,
  );
  expect(await h.db.select().from(journalEntries)).toHaveLength(0);
  expect(beforeApproval.every((row) => row === null)).toBe(true);
  expect(
    (await listConnections(h.db, f.ownerId))[0].accounts.map((row) => row.openingPendingCount).sort(),
  ).toEqual([1, 2]);
  const rows = (await h.db.select().from(importRows)).filter(
    (row) => row.providerTransactionId !== "unapproved",
  );
  await updateImportRows(h.db, f.ownerId, rows[0].statementId, {
    rowIds: rows.map((row) => row.id),
    changes: { decision: "approve" },
  });
  await approveRows(h.db, f.ownerId, rows[0].statementId, {
    rowIds: rows.map((row) => row.id),
    idempotencyKey: "synthetic-opening-approval",
  });
  const suggestions = (await listConnections(h.db, f.ownerId))[0].accounts;
  expect(suggestions.find((row) => row.type === "depository")!.openingSuggestion).toBeNull();
  const [pending] = (await h.db.select().from(importRows)).filter(
    (row) => row.providerTransactionId === "unapproved",
  );
  await updateImportRows(h.db, f.ownerId, pending.statementId, {
    rowIds: [pending.id],
    changes: { decision: "exclude" },
  });
  expect(
    (await listConnections(h.db, f.ownerId))[0].accounts.find((row) => row.type === "depository")!
      .openingSuggestion,
  ).toMatchObject({
    amount: "1020.0000",
    syncedBalance: "1000.0000",
    syncedFlows: "-20.0000",
    eventDate: "2026-09-30",
  });
  expect(suggestions.find((row) => row.type === "credit")!.openingSuggestion).toMatchObject({
    amount: "-170.0000",
    syncedBalance: "-200.0000",
    syncedFlows: "-30.0000",
  });
  const card = mapped.find((row) => row.type === "credit")!;
  await expect(
    confirmOpeningBalance(h.db, f.otherId, id, config, { bankAccountId: card.id, amount: "-170" }),
  ).rejects.toThrow("不存在");
  const first = await confirmOpeningBalance(h.db, f.ownerId, id, config, {
    bankAccountId: card.id,
    amount: "-175",
  });
  const second = await confirmOpeningBalance(h.db, f.ownerId, id, config, {
    bankAccountId: card.id,
    amount: "-170",
  });
  expect(second.id).toBe(first.id);
  expect(first).toMatchObject({ entryType: "opening_balance", eventDate: "2026-09-30" });
  expect(first.postings.find((row) => row.accountId === card.accountId)!.amount).toBe("-175.0000");
  expect(await accountBalance(h.db, f.ownerId, card.accountId!, "2026-10-24")).toBe("-205.0000");
  expect(
    (await listConnections(h.db, f.ownerId))[0].accounts.find((row) => row.id === card.id)!.openingSuggestion,
  ).toBeNull();
  expect(
    await h.db.select().from(journalEntries).where(eq(journalEntries.entryType, "opening_balance")),
  ).toHaveLength(1);
  expect(
    (await h.db.select().from(auditLogs)).some(
      (row) => row.action === "bank.opening_balance" && row.entityId === card.id,
    ),
  ).toBe(true);
  await voidEntry(h.db, f.ownerId, first.id, "Synthetic correction");
  expect(
    (await listConnections(h.db, f.ownerId))[0].accounts.find((row) => row.id === card.id)!.openingSuggestion,
  ).not.toBeNull();
  await confirmOpeningBalance(h.db, f.ownerId, id, config, { bankAccountId: card.id, amount: "-170" });
  expect(await accountBalance(h.db, f.ownerId, card.accountId!, "2026-10-24")).toBe("-200.0000");
});

it("ignores unapproved or excluded evidence in ledger-derived openings and uses the latest balance", async () => {
  client.accountRows = [bankAccount()];
  const { id } = await createMapped();
  client.page = () => transactionPage([bankTransaction("spend")]);
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  const suggestion = async () => (await listConnections(h.db, f.ownerId))[0].accounts[0].openingSuggestion;
  const original = await suggestion();
  expect(original).toBeNull();
  const [row] = await h.db.select().from(importRows);
  await updateImportRows(h.db, f.ownerId, row.statementId, {
    rowIds: [row.id],
    changes: {
      decision: "exclude",
      duplicateResolution: "duplicate",
      amount: "-999",
      postedDate: "2026-09-01",
    },
  });
  expect(await suggestion()).toMatchObject({
    amount: "1000.0000",
    syncedFlows: "0.0000",
    transactionCount: 0,
  });
  client.accountRows[0].current = "990";
  client.page = () => ({ ...transactionPage([]), modified: [bankTransaction("spend", { amount: "30" })] });
  await syncConnection(h.db, f.ownerId, id, client, config, new Date(now.getTime() + 60000));
  expect(await suggestion()).toBeNull();
  expect((await listConnections(h.db, f.ownerId))[0].accounts[0].openingPendingCount).toBe(1);
  client.accountRows[0].current = "1020";
  client.page = () => ({ ...transactionPage([]), removed: ["spend"] });
  await syncConnection(h.db, f.ownerId, id, client, config, new Date(now.getTime() + 120000));
  expect(await suggestion()).toMatchObject({
    amount: "1020.0000",
    syncedFlows: "0.0000",
    transactionCount: 0,
  });
});

it("offers only brokerage cash as an opening suggestion, never securities market value", async () => {
  client.item.products = ["investments"];
  client.accountRows = [bankAccount("invest", "investment", "1200")];
  client.holdingsResult = {
    accounts: client.accountRows,
    holdings: [
      { accountId: "invest", currency: "USD", value: "1000.0000", cash: false },
      { accountId: "invest", currency: "USD", value: "200.0000", cash: true },
    ],
  };
  const { id, mapped } = await createMapped();
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  const [connection] = await listConnections(h.db, f.ownerId);
  expect(connection.accounts[0].openingSuggestion).toMatchObject({
    accountId: mapped[0].accountId,
    amount: "200.0000",
  });
  const opening = await confirmOpeningBalance(h.db, f.ownerId, id, config, {
    bankAccountId: mapped[0].id,
    amount: "200",
  });
  expect(opening.postings.some((row) => row.accountId === mapped[0].securityAccountId)).toBe(false);
  expect(await accountBalance(h.db, f.ownerId, mapped[0].securityAccountId!, "2026-10-24")).toBe("0.0000");
});

it("hides opening creation from mappings while the existing API still accepts four-decimal amounts", async () => {
  client.accountRows = [bankAccount("loan", "loan", "500.0000")];
  const { id, mapped } = await createMapped();
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  const [connection] = await listConnections(h.db, f.ownerId);
  const html = renderToStaticMarkup(
    <MappingForm connection={jsonSafe(connection)} accounts={await listAccounts(h.db, f.ownerId)} />,
  );
  expect(html).not.toContain("期初");
  expect(html).toContain("此账户仅同步余额");
  await confirmOpeningBalance(h.db, f.ownerId, id, config, {
    bankAccountId: mapped[0].id,
    amount: "-500.1234",
  });
  expect(await accountBalance(h.db, f.ownerId, mapped[0].accountId!, "2026-10-24")).toBe("-500.1234");
});

it("keeps legacy opening API protections for existing mappings, drafts and zero without a creation UI", async () => {
  client.accountRows = [bankAccount("bank", "depository", "0")];
  const { id, mapped } = await createMapped();
  await syncConnection(h.db, f.ownerId, id, client, config, now);
  const [connection] = await listConnections(h.db, f.ownerId);
  expect(connection.accounts[0].openingSuggestion!.amount).toBe("0.0000");
  const html = renderToStaticMarkup(
    <MappingForm connection={jsonSafe(connection)} accounts={await listAccounts(h.db, f.ownerId)} />,
  );
  expect(html).not.toContain('value="0.00"');
  expect(html).not.toContain("期初");
  await expect(
    confirmOpeningBalance(h.db, f.ownerId, id, config, { bankAccountId: mapped[0].id, amount: "0" }),
  ).rejects.toThrow();
  await createQuickEntry(h.db, f.ownerId, {
    type: "opening_balance",
    toAccountId: mapped[0].accountId!,
    amount: "10",
    eventDate: "2026-09-30",
    status: "draft",
  });
  expect((await listConnections(h.db, f.ownerId))[0].accounts[0].openingSuggestion).toBeNull();
  client.item.id = "item-existing";
  const existing = await connect();
  await saveMapping(
    h.db,
    f.ownerId,
    existing.connection.id,
    config,
    {
      importFromDate: "2026-10-01",
      accounts: [{ id: existing.accounts[0].id, accountId: f.bank.id, isEnabled: true }],
    },
    now,
  );
  await syncConnection(h.db, f.ownerId, existing.connection.id, client, config, now);
  expect(
    (await listConnections(h.db, f.ownerId)).find((row) => row.id === existing.connection.id)!.accounts[0]
      .openingSuggestion,
  ).not.toBeNull();
});

it("creates and assigns an uploaded statement account atomically through the API and rejects foreign ownership", async () => {
  const data = await pdf("7788", "Example Issuer");
  const body = { create: { name: "New Uploaded Card", type: "liability_credit_card", currency: "USD" } };
  const request = (value: unknown) =>
    new NextRequest("http://localhost:3000/api/statements/test", {
      method: "PATCH",
      headers: {
        host: "localhost:3000",
        origin: "http://localhost:3000",
        cookie: `al_session=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
    });
  const response = await assignmentRoute.PATCH(request(body), {
    params: Promise.resolve({ id: data.statement.id }),
  });
  expect(response.status).toBe(200);
  const saved = await response.json();
  expect(await requireAccount(h.db, f.ownerId, saved.accountId)).toMatchObject({
    last4: "7788",
    type: "liability_credit_card",
    cashLikeInclusion: true,
  });
  expect((await getStatementReview(h.db, f.ownerId, data.statement.id)).statement.accountId).toBe(
    saved.accountId,
  );
  const before = await h.db.select().from(accounts);
  const bad = await assignmentRoute.PATCH(
    request({ create: { ...body.create, type: "asset_cash", name: "Invalid checking" } }),
    { params: Promise.resolve({ id: data.statement.id }) },
  );
  expect(bad.status).toBe(400);
  expect(await h.db.select().from(accounts)).toEqual(before);
  await expect(setStatementAccount(h.db, f.otherId, data.statement.id, body)).rejects.toThrow("不存在");
});

it("renders a single import hub with conditional Plaid entry and the linkable sync tab; old settings URL redirects permanently", async () => {
  const render = async (tab?: string) =>
    renderToStaticMarkup(await hub.default({ searchParams: Promise.resolve({ tab }) }));
  let html = await render();
  expect(html).toContain("上传 PDF / CSV");
  expect(html).toContain("连接银行（Plaid）");
  expect(html).toContain("收件箱");
  expect(html).toContain("自动同步");
  const { id } = await createMapped();
  html = await render("sync");
  expect(html).toContain(`id="connection-${id}"`);
  expect(html).toContain("立即同步");
  expect(html).toContain("请求银行刷新");
  expect(html).toContain("新建账户");
  expect(() => legacyPage.default()).toThrow("PERMANENT:/statements?tab=sync");
  vi.stubEnv("PLAID_ENABLED", "false");
  html = await render("sync");
  expect(html).toContain("上传 PDF / CSV");
  expect(html).not.toContain("连接银行（Plaid）");
  expect(html).not.toContain("自动同步");
  expect(html).not.toContain("立即同步");
});
