import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { statements, journalEntries, bankConnectionAccounts } from "@/db/schema";
import { createSession } from "@/lib/auth/session";
import { createQuickEntry } from "@/lib/ledger/builders";
import { createAccount, updateAccount, listAccounts } from "@/lib/ledger/accounts";
import { applyParsedStatement } from "@/lib/imports/processing";
import { getStatementReview, setStatementAccount } from "@/lib/imports/service";
import { updateImportRows } from "@/lib/imports/review";
import { approvalProblems, approvalSelection, compatibleStatementAccount } from "@/lib/imports/readiness";
import { approveRows } from "@/lib/imports/approval";
import { refreshSuggestions } from "@/lib/imports/suggestions";
import { StatementReviewView } from "@/components/imports/review-view";
import { ConnectionsView } from "@/components/bank-sync/connections-view";
import { exchangeConnection, listConnections, saveMapping } from "@/lib/bank-sync/connections";
import { jsonSafe } from "@/lib/serialization";
import { FakePlaid, bankAccount, plaidConfig } from "./helpers/plaid";
let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
let token: string;
vi.mock("@/db/client", () => ({ getDb: () => h.db }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
const approval = await import("@/app/api/statements/[id]/approve/route");
beforeAll(async () => {
  h = await createTestDb();
  vi.stubEnv("APP_SECRET", "synthetic-ux-test-secret-32-characters");
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
  token = (await createSession(h.db, f.ownerId, { ipHash: "synthetic", userAgent: "Test" })).token;
});
async function parsed(accountId: string | null = f.card.id) {
  const [statement] = await h.db
    .insert(statements)
    .values({
      ownerId: f.ownerId,
      accountId,
      fileSha256: "f".repeat(64),
      originalFilename: "Synthetic.pdf",
      mime: "application/pdf",
      sizeBytes: 100,
    })
    .returning();
  await applyParsedStatement(h.db, f.ownerId, statement.id, {
    statement_type: "credit_card",
    account_last4: "1234",
    currency: "USD",
    page_count: 1,
    parser: "synthetic",
    parser_version: "1",
    entries: [
      {
        transaction_date: "2026-10-24",
        posted_date: "2026-10-24",
        description_raw: "EXAMPLE CAFE",
        merchant_normalized: "EXAMPLE CAFE",
        amount_raw: "20",
        amount: "-20",
        currency: "USD",
        direction: "charge",
        confidence: "1",
        source_row_text: "Synthetic charge",
      },
      {
        transaction_date: "2026-10-24",
        posted_date: "2026-10-24",
        description_raw: "PAYMENT",
        merchant_normalized: "PAYMENT",
        amount_raw: "100",
        amount: "100",
        currency: "USD",
        direction: "payment",
        confidence: "1",
        source_row_text: "Synthetic payment",
      },
    ],
    summary: {},
    diagnostics: [],
    transaction_lines: [],
  });
  return getStatementReview(h.db, f.ownerId, statement.id);
}
it("missing categories/counter accounts render inline and server approval returns indexed reasons atomically", async () => {
  const data = await parsed();
  expect(approvalProblems(data.rows[0])).toContain("缺少分类");
  expect(approvalProblems(data.rows[1])).toContain("缺少付款账户");
  const html = renderToStaticMarkup(
    <StatementReviewView
      data={data}
      accounts={await listAccounts(h.db, f.ownerId)}
      categories={f.categories}
      ai={{
        available: false,
        provider: "Anthropic",
        model: "synthetic",
        lines: [],
        inputHash: "f".repeat(64),
      }}
      rewards={null}
    />,
  );
  expect(html).toContain("缺少分类");
  expect(html).toContain("缺少付款账户");
  expect(html).toContain("批准可入账的 0 行（跳过 0 行待补全）");
  const ids = data.rows.map((row) => row.id);
  await updateImportRows(h.db, f.ownerId, data.statement.id, {
    rowIds: ids,
    changes: { decision: "approve" },
  });
  const response = await approval.POST(
    new NextRequest("http://localhost:3000/api/statements/approve", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        origin: "http://localhost:3000",
        cookie: `al_session=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ rowIds: ids, idempotencyKey: "synthetic-ux-key" }),
    }),
    { params: Promise.resolve({ id: data.statement.id }) },
  );
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.error).toContain("第 1 行：缺少分类");
  expect(body.error).toContain("第 2 行：缺少付款账户");
  expect(body.rowErrors).toEqual([
    { rowId: ids[0], rowIndex: 0, reasons: ["缺少分类"] },
    { rowId: ids[1], rowIndex: 1, reasons: ["缺少付款账户"] },
  ]);
  expect(await h.db.select().from(journalEntries)).toHaveLength(0);
});
it("approves only ready selected rows and leaves incomplete or excluded rows untouched", async () => {
  const initial = await parsed();
  await updateImportRows(h.db, f.ownerId, initial.statement.id, {
    rowIds: [initial.rows[0].id],
    changes: { suggestedCategoryId: f.category("餐饮") },
  });
  const data = await getStatementReview(h.db, f.ownerId, initial.statement.id);
  const selection = approvalSelection(data.rows);
  expect(selection.incompleteCount).toBe(1);
  expect(selection.readyRows.map((row) => row.id)).toEqual([data.rows[0].id]);
  const ids = selection.readyRows.map((row) => row.id);
  await updateImportRows(h.db, f.ownerId, data.statement.id, {
    rowIds: ids,
    changes: { decision: "approve" },
  });
  await expect(
    approveRows(h.db, f.ownerId, data.statement.id, {
      rowIds: data.rows.map((row) => row.id),
      idempotencyKey: "mixed-incomplete-selection",
    }),
  ).rejects.toMatchObject({
    rowErrors: [{ rowId: data.rows[1].id, rowIndex: 1, reasons: ["缺少付款账户"] }],
  });
  expect(await h.db.select().from(journalEntries)).toHaveLength(0);
  await approveRows(h.db, f.ownerId, data.statement.id, {
    rowIds: ids,
    idempotencyKey: "ready-only-selection",
  });
  const reviewed = await getStatementReview(h.db, f.ownerId, data.statement.id);
  expect(await h.db.select().from(journalEntries)).toHaveLength(1);
  expect(reviewed.rows[0].journalEntryId).not.toBeNull();
  expect(reviewed.rows[1]).toMatchObject({ decision: "pending", journalEntryId: null });
  expect(reviewed.statement.status).toBe("needs_review");
  expect(approvalSelection(reviewed.rows)).toEqual({ readyRows: [], incompleteCount: 1 });
  await updateImportRows(h.db, f.ownerId, data.statement.id, {
    rowIds: [data.rows[1].id],
    changes: { decision: "exclude" },
  });
  expect(approvalSelection((await getStatementReview(h.db, f.ownerId, data.statement.id)).rows)).toEqual({
    readyRows: [],
    incompleteCount: 0,
  });
});
it("saved statement account renders selected and filters incompatible types; last4 supports auto matching", async () => {
  const cnyCard = await createAccount(h.db, f.ownerId, {
    name: "Synthetic CNY Card",
    type: "liability_credit_card",
    currency: "CNY",
  });
  await createQuickEntry(h.db, f.ownerId, {
    type: "credit_card_payment",
    fromAccountId: f.bank.id,
    toAccountId: f.card.id,
    amount: "100",
    eventDate: "2026-10-01",
  });
  const initial = await parsed(null);
  expect(initial.statement.accountId).toBeNull();
  expect(initial.statement.status).toBe("needs_mapping");
  expect(initial.rows[1].suggestedCounterAccountId).toBeNull();
  const saved = await setStatementAccount(h.db, f.ownerId, initial.statement.id, f.card.id);
  expect(saved.accountId).toBe(f.card.id);
  const data = await getStatementReview(h.db, f.ownerId, initial.statement.id);
  expect(data.statement.status).toBe("needs_review");
  expect(data.rows[1].suggestedCounterAccountId).toBe(f.bank.id);
  const html = renderToStaticMarkup(
    <StatementReviewView
      data={data}
      accounts={await listAccounts(h.db, f.ownerId)}
      categories={f.categories}
      ai={{
        available: false,
        provider: "Anthropic",
        model: "synthetic",
        lines: [],
        inputHash: "f".repeat(64),
      }}
      rewards={null}
    />,
  );
  expect(html).toContain(`<option value="${f.card.id}" selected="">`);
  expect(html).not.toContain(`<option value="${f.bank.id}">`);
  expect(html).not.toContain(`<option value="${cnyCard.id}">`);
  expect(compatibleStatementAccount("bank", f.bank)).toBe(true);
  expect(compatibleStatementAccount("bank", f.broker)).toBe(true);
  expect(compatibleStatementAccount("bank", f.card)).toBe(false);
  expect(compatibleStatementAccount("bank", f.wallet, false, "USD")).toBe(false);
  expect(compatibleStatementAccount("bank", f.wallet, false, "CNY")).toBe(true);
  expect(compatibleStatementAccount("bank", f.wallet, false, null)).toBe(true);
  await updateAccount(h.db, f.ownerId, f.card.id, { last4: "1234" });
  await h.db.update(statements).set({ accountId: null }).where(eq(statements.id, data.statement.id));
  // Reprocess a synthetic layout using the stored last4; no filename/real sample inspection.
  await applyParsedStatement(h.db, f.ownerId, data.statement.id, {
    statement_type: "credit_card",
    account_last4: "1234",
    currency: "USD",
    page_count: 1,
    parser: "synthetic",
    parser_version: "1",
    entries: [],
    summary: {},
    diagnostics: [],
    transaction_lines: [],
  });
  expect((await getStatementReview(h.db, f.ownerId, data.statement.id)).statement.accountId).toBe(f.card.id);
});
it("loan mapping shows only matching liability accounts and its balance-only note", async () => {
  const loan = await createAccount(h.db, f.ownerId, {
    name: "Example USD Loan",
    type: "liability_loan",
    currency: "USD",
    last4: "1234",
  });
  const foreignLoan = await createAccount(h.db, f.ownerId, {
    name: "Example CNY Loan",
    type: "liability_loan",
    currency: "CNY",
    last4: "1234",
  });
  const client = new FakePlaid();
  client.accountRows = [bankAccount("loan", "loan", "2500")];
  await exchangeConnection(h.db, f.ownerId, client, plaidConfig, {
    public_token: "public-sandbox-synthetic",
    institution: { institution_id: "ins_synthetic", name: "Example Bank" },
  });
  const html = renderToStaticMarkup(
    <ConnectionsView
      timezone="America/Los_Angeles"
      connections={jsonSafe(await listConnections(h.db, f.ownerId))}
      accounts={await listAccounts(h.db, f.ownerId)}
      environment="sandbox"
      interval={12}
    />,
  );
  expect(html).toContain("贷款账户仅同步余额");
  expect(html).toContain(`<option value="${loan.id}" selected="">`);
  for (const account of [f.bank, f.card, foreignLoan])
    expect(html).not.toContain(`<option value="${account.id}"`);
});
it("payment defaults use this card's most recent confirmed payment and never overwrite an owner's choice", async () => {
  await createQuickEntry(h.db, f.ownerId, {
    type: "credit_card_payment",
    fromAccountId: f.bank.id,
    toAccountId: f.card.id,
    amount: "100",
    eventDate: "2026-10-01",
  });
  await createQuickEntry(h.db, f.ownerId, {
    type: "credit_card_payment",
    fromAccountId: f.broker.id,
    toAccountId: f.card.id,
    amount: "200",
    eventDate: "2026-10-20",
  });
  const data = await parsed();
  expect(data.rows[1].suggestedCounterAccountId).toBe(f.broker.id);
  await updateImportRows(h.db, f.ownerId, data.statement.id, {
    rowIds: [data.rows[1].id],
    changes: { suggestedCounterAccountId: f.bank.id },
  });
  await refreshSuggestions(h.db, f.ownerId, data.statement.id);
  expect(
    (await getStatementReview(h.db, f.ownerId, data.statement.id)).rows[1].suggestedCounterAccountId,
  ).toBe(f.bank.id);
});
it("does not default a payment's counter account to an enabled Plaid mapping, but preserves an explicit choice", async () => {
  await createQuickEntry(h.db, f.ownerId, {
    type: "credit_card_payment",
    fromAccountId: f.bank.id,
    toAccountId: f.card.id,
    amount: "50",
    eventDate: "2026-10-01",
  });
  const client = new FakePlaid();
  client.accountRows = [bankAccount("bank")];
  const linked = await exchangeConnection(h.db, f.ownerId, client, plaidConfig, {
    public_token: "public-sandbox-synthetic",
    institution: { institution_id: "ins_synthetic", name: "Example Bank" },
  });
  await saveMapping(h.db, f.ownerId, linked.connection.id, plaidConfig, {
    importFromDate: "2026-10-01",
    accounts: [{ id: linked.accounts[0].id, accountId: f.bank.id }],
  });
  const data = await parsed();
  const payment = data.rows[1];
  const waiting = "等待对方账户同步或手动匹配";
  expect(payment.suggestedCounterAccountId).toBeNull();
  expect(payment.softNotes).toContain(waiting);
  expect(approvalProblems(payment)).toContain("缺少付款账户");
  expect(
    renderToStaticMarkup(
      <StatementReviewView
        data={data}
        accounts={await listAccounts(h.db, f.ownerId)}
        categories={f.categories}
        ai={{ available: false, provider: "Anthropic", model: "synthetic", lines: [], inputHash: "f" }}
        rewards={null}
      />,
    ),
  ).toContain(waiting);
  await refreshSuggestions(h.db, f.ownerId, data.statement.id);
  expect((await getStatementReview(h.db, f.ownerId, data.statement.id)).rows[1].softNotes).toEqual([waiting]);
  await h.db
    .update(bankConnectionAccounts)
    .set({ isEnabled: false })
    .where(eq(bankConnectionAccounts.id, linked.accounts[0].id));
  await refreshSuggestions(h.db, f.ownerId, data.statement.id);
  const disabled = (await getStatementReview(h.db, f.ownerId, data.statement.id)).rows[1];
  expect(disabled.suggestedCounterAccountId).toBe(f.bank.id);
  expect(disabled.softNotes).not.toContain(waiting);
  await h.db
    .update(bankConnectionAccounts)
    .set({ isEnabled: true })
    .where(eq(bankConnectionAccounts.id, linked.accounts[0].id));
  await refreshSuggestions(h.db, f.ownerId, data.statement.id);
  expect(
    (await getStatementReview(h.db, f.ownerId, data.statement.id)).rows[1].suggestedCounterAccountId,
  ).toBeNull();
  await updateImportRows(h.db, f.ownerId, data.statement.id, {
    rowIds: [payment.id],
    changes: { suggestedCounterAccountId: f.bank.id },
  });
  const selected = (await getStatementReview(h.db, f.ownerId, data.statement.id)).rows[1];
  expect(selected.suggestedCounterAccountId).toBe(f.bank.id);
  expect(selected.softNotes).not.toContain(waiting);
});
