import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { importJobs, journalEntries, statements, csvMappings } from "@/db/schema";
import { uploadStatement, saveCsvMapping, getStatementReview } from "@/lib/imports/service";
import { claimJob, processJob } from "@/lib/imports/jobs";
import { updateImportRows } from "@/lib/imports/review";
import { approveRows } from "@/lib/imports/approval";
import { retainFiles, observeStatementBalance } from "@/lib/imports/evidence";
import { statementRows } from "@/lib/imports/store";
import { parseCsv, amexMapping } from "@/lib/imports/csv";
import { spendingSummary } from "@/lib/ledger/queries";
let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
let dir: string;
const config = {
  DATA_DIR: "",
  MAX_UPLOAD_MB: 20,
  MAX_PDF_PAGES: 60,
  PARSER_URL: "",
  FILE_RETENTION_DAYS: 30,
  AI_PARSING_ENABLED: "false",
  ANTHROPIC_API_KEY: "",
  AI_MODEL: "",
};
const bytes = (value: string) => new TextEncoder().encode(value);
const amex = (rows = "10/12/2026,,EXAMPLE CAFE,20.00") => `Date,Receipt,Description,Amount\n${rows}\n`;
beforeAll(async () => {
  h = await createTestDb();
  dir = await mkdtemp(join(tmpdir(), "asset-import-tests-"));
  config.DATA_DIR = dir;
});
afterAll(async () => {
  await h.client.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
});
async function processNext() {
  const job = await claimJob(h.db, "test-worker");
  expect(job).not.toBeNull();
  await processJob(h.db, job!, config);
  const [done] = await h.db.select().from(importJobs).where(eq(importJobs.id, job!.id));
  expect(done.errorKind).toBeNull();
  expect(done.status).toBe("succeeded");
}
async function upload(text: string, accountId = f.card.id) {
  const statement = await uploadStatement(
    h.db,
    f.ownerId,
    { bytes: bytes(text), filename: "synthetic.wrong-extension", accountId },
    config,
  );
  await processNext();
  return statement;
}
async function approve(statementId: string, rowIds: string[], key = "synthetic-key-0001") {
  await updateImportRows(h.db, f.ownerId, statementId, {
    rowIds,
    changes: { decision: "approve", suggestedCategoryId: f.category("餐饮") },
  });
  return approveRows(h.db, f.ownerId, statementId, { rowIds, idempotencyKey: key });
}
it("normalizes the Amex preset without floats, payment duplication or provider IDs", () => {
  const result = parseCsv(
    bytes(
      amex(
        "10/12/2026,,EXAMPLE SHOP,12.34\n10/13/2026,,AUTOPAY PAYMENT,-50.00\n10/14/2026,,EXAMPLE RETURN,-5.00",
      ),
    ),
    amexMapping,
    f.card,
  );
  expect(result.entries.map((row) => [row.amount, row.direction])).toEqual([
    ["-12.3400", "charge"],
    ["50.0000", "payment"],
    ["5.0000", "refund"],
  ]);
  expect(result.entries.every((row) => row.provider_transaction_id === null)).toBe(true);
});
it("deduplicates uploads, approvals and uploads after approval; same-statement purchases remain distinct", async () => {
  const text = amex("10/12/2026,,EXAMPLE CAFE,20.00\n10/12/2026,,EXAMPLE CAFE,20.00");
  const statement = await upload(text);
  const again = await uploadStatement(
    h.db,
    f.ownerId,
    { bytes: bytes(text), filename: "again.csv", accountId: f.card.id },
    config,
  );
  expect(again.id).toBe(statement.id);
  const rows = await statementRows(h.db, f.ownerId, statement.id);
  expect(rows).toHaveLength(2);
  expect(
    rows.every((row) => row.duplicateCandidateRowIds.length === 0 && row.softNotes.includes("同日同额两笔")),
  ).toBe(true);
  const ids = rows.map((row) => row.id);
  const first = await approve(statement.id, ids);
  expect(first).toHaveLength(2);
  expect(first[0].entryId).not.toBe(first[1].entryId);
  expect(
    await approveRows(h.db, f.ownerId, statement.id, { rowIds: ids, idempotencyKey: "synthetic-key-0001" }),
  ).toEqual(first);
  expect(
    await approveRows(h.db, f.ownerId, statement.id, { rowIds: ids, idempotencyKey: "different-key-0002" }),
  ).toEqual(first);
  await expect(
    approveRows(h.db, f.ownerId, statement.id, { rowIds: [ids[0]], idempotencyKey: "synthetic-key-0001" }),
  ).rejects.toThrow("幂等键");
  const after = await uploadStatement(h.db, f.ownerId, { bytes: bytes(text), filename: "after.csv" }, config);
  expect(after.id).toBe(statement.id);
  expect(await h.db.select().from(journalEntries)).toHaveLength(2);
  const totals = await spendingSummary(h.db, f.ownerId, {
    from: "2026-10-01",
    to: "2026-10-31",
    basis: "posted",
    groupBy: "month",
  });
  expect(totals[0].amount).toBe("40.0000");
});
it("saves and reuses per-account CSV mappings and enforces provider IDs", async () => {
  const csv =
    "Example synthetic export\nWhen,Merchant,Debit,Credit,Reference\n2026-10-12,EXAMPLE SHOP,15.00,,BANK-DEMO-1\n";
  const statement = await upload(csv, f.bank.id);
  expect((await getStatementReview(h.db, f.ownerId, statement.id)).statement.status).toBe("needs_mapping");
  await saveCsvMapping(
    h.db,
    f.ownerId,
    statement.id,
    {
      name: "Example mapping",
      mapping: {
        dateColumn: "When",
        dateFormat: "YYYY-MM-DD",
        descriptionColumn: "Merchant",
        debitColumn: "Debit",
        creditColumn: "Credit",
        referenceColumn: "Reference",
        signConvention: "account_signed",
        skipRows: 1,
      },
    },
    config,
  );
  await processNext();
  const rows = await statementRows(h.db, f.ownerId, statement.id);
  await updateImportRows(h.db, f.ownerId, statement.id, {
    rowIds: [rows[0].id],
    changes: { decision: "approve", suggestedEntryType: "expense", suggestedCategoryId: f.category("购物") },
  });
  const first = await approveRows(h.db, f.ownerId, statement.id, {
    rowIds: [rows[0].id],
    idempotencyKey: "provider-key-1",
  });
  const second = await upload(csv + "\n", f.bank.id);
  expect(await h.db.select().from(csvMappings)).toHaveLength(1);
  const candidate = (await statementRows(h.db, f.ownerId, second.id))[0];
  expect(candidate.duplicateCandidateEntryIds).toContain(first[0].entryId);
  await updateImportRows(h.db, f.ownerId, second.id, {
    rowIds: [candidate.id],
    changes: {
      decision: "approve",
      duplicateResolution: "distinct",
      suggestedEntryType: "expense",
      suggestedCategoryId: f.category("购物"),
    },
  });
  await expect(
    approveRows(h.db, f.ownerId, second.id, { rowIds: [candidate.id], idempotencyKey: "provider-key-2" }),
  ).rejects.toThrow("银行交易编号");
});
it("flags candidates across files but never merges without an explicit decision", async () => {
  const one = await upload(amex());
  const firstRow = (await statementRows(h.db, f.ownerId, one.id))[0];
  const two = await upload(amex() + "\n");
  const secondRow = (await statementRows(h.db, f.ownerId, two.id))[0];
  expect(secondRow.duplicateCandidateRowIds).toContain(firstRow.id);
  expect(await h.db.select().from(journalEntries)).toHaveLength(0);
  const first = await approve(one.id, [firstRow.id]);
  expect((await statementRows(h.db, f.ownerId, two.id))[0].duplicateCandidateEntryIds).toContain(
    first[0].entryId,
  );
  await updateImportRows(h.db, f.ownerId, two.id, {
    rowIds: [secondRow.id],
    changes: {
      decision: "link_existing",
      duplicateResolution: "duplicate",
      decisionPayload: { linkEntryId: first[0].entryId },
    },
  });
  await approveRows(h.db, f.ownerId, two.id, { rowIds: [secondRow.id], idempotencyKey: "explicit-link-1" });
  expect(await h.db.select().from(journalEntries)).toHaveLength(1);
});
it("pairs card payment and bank debit as one credit-card payment with no spending", async () => {
  const card = await upload(amex("10/13/2026,,AUTOPAY PAYMENT,-50.00"));
  const bankCsv = "Date,Description,Amount\n10/12/2026,CARD PAYMENT,-50.00\n";
  const bank = await upload(bankCsv, f.bank.id);
  await saveCsvMapping(
    h.db,
    f.ownerId,
    bank.id,
    {
      name: "Bank",
      mapping: {
        dateColumn: "Date",
        dateFormat: "MM/DD/YYYY",
        descriptionColumn: "Description",
        amountColumn: "Amount",
        signConvention: "account_signed",
        skipRows: 0,
      },
    },
    config,
  );
  await processNext();
  const cardRow = (await statementRows(h.db, f.ownerId, card.id))[0];
  const bankRow = (await statementRows(h.db, f.ownerId, bank.id))[0];
  expect(cardRow.pairing.some((pair) => pair.rowId === bankRow.id)).toBe(true);
  await updateImportRows(h.db, f.ownerId, card.id, {
    rowIds: [cardRow.id],
    changes: { decision: "approve", decisionPayload: { pairRowId: bankRow.id } },
  });
  const result = await approveRows(h.db, f.ownerId, card.id, {
    rowIds: [cardRow.id],
    idempotencyKey: "payment-pair-1",
  });
  expect((await statementRows(h.db, f.ownerId, bank.id))[0].linkedEntryId).toBe(result[0].entryId);
  expect(
    await approveRows(h.db, f.ownerId, bank.id, { rowIds: [bankRow.id], idempotencyKey: "bank-again-1" }),
  ).toEqual([{ rowId: bankRow.id, entryId: result[0].entryId }]);
  const entries = await h.db.select().from(journalEntries);
  expect(entries).toHaveLength(1);
  expect(entries[0].entryType).toBe("credit_card_payment");
  expect(
    await spendingSummary(h.db, f.ownerId, {
      from: "2026-10-01",
      to: "2026-10-31",
      basis: "posted",
      groupBy: "month",
    }),
  ).toEqual([]);
});
it("rolls back the entire approval when one row is invalid and isolates owners", async () => {
  const statement = await upload(amex("10/12/2026,,EXAMPLE SHOP,12.00\n10/13/2026,,EXAMPLE CAFE,13.00"));
  const rows = await statementRows(h.db, f.ownerId, statement.id);
  await updateImportRows(h.db, f.ownerId, statement.id, {
    rowIds: rows.map((row) => row.id),
    changes: { decision: "approve", suggestedCategoryId: f.category("购物") },
  });
  await updateImportRows(h.db, f.ownerId, statement.id, { rowIds: [rows[1].id], changes: { amount: "0" } });
  await expect(
    approveRows(h.db, f.ownerId, statement.id, {
      rowIds: rows.map((row) => row.id),
      idempotencyKey: "atomic-key-1",
    }),
  ).rejects.toThrow("零金额");
  expect(await h.db.select().from(journalEntries)).toHaveLength(0);
  expect((await statementRows(h.db, f.ownerId, statement.id)).every((row) => !row.journalEntryId)).toBe(true);
  await expect(getStatementReview(h.db, f.otherId, statement.id)).rejects.toThrow("账单不存在");
  await expect(
    approveRows(h.db, f.otherId, statement.id, { rowIds: [rows[0].id], idempotencyKey: "other-user-1" }),
  ).rejects.toThrow("账单不存在");
});
it("claims queued work with SKIP LOCKED once and retries only three times", async () => {
  const one = await uploadStatement(
    h.db,
    f.ownerId,
    { bytes: bytes(amex()), filename: "one.csv", accountId: f.card.id },
    config,
  );
  const two = await uploadStatement(
    h.db,
    f.ownerId,
    { bytes: bytes(amex() + "\n"), filename: "two.csv", accountId: f.card.id },
    config,
  );
  const claims = await Promise.all([claimJob(h.db, "worker-a"), claimJob(h.db, "worker-b")]);
  expect(new Set(claims.map((job) => job!.id)).size).toBe(2);
  expect(new Set(claims.map((job) => job!.statementId))).toEqual(new Set([one.id, two.id]));
  expect(await claimJob(h.db, "worker-c")).toBeNull();
  await processJob(
    h.db,
    claims.find((job) => job!.statementId === two.id)!,
    config,
  );
  await h.db.update(statements).set({ storagePath: null }).where(eq(statements.id, one.id));
  const broken = claims.find((job) => job!.statementId === one.id)!;
  await processJob(h.db, broken!, config);
  let now = new Date(Date.now() + 600000);
  for (let index = 0; index < 2; index++) {
    const job = await claimJob(h.db, "retry-worker", now);
    expect(job?.statementId).toBe(one.id);
    await processJob(h.db, job!, config, now);
    now = new Date(now.getTime() + 600000);
  }
  const [failed] = await h.db.select().from(importJobs).where(eq(importJobs.id, broken!.id));
  expect(failed.status).toBe("failed");
  expect(failed.attempts).toBe(3);
  expect(failed.errorKind).toBe("import_failed");
});
it("retains private files until approval deadline and leaves evidence after deletion", async () => {
  const statement = await upload(amex());
  const [stored] = await h.db.select().from(statements).where(eq(statements.id, statement.id));
  expect((await stat(stored.storagePath!)).mode & 0o777).toBe(0o600);
  const row = (await statementRows(h.db, f.ownerId, statement.id))[0];
  await approve(statement.id, [row.id]);
  await retainFiles(h.db, config, new Date(Date.now() + 29 * 86400000));
  expect(await readFile(stored.storagePath!)).toBeTruthy();
  await retainFiles(h.db, config, new Date(Date.now() + 31 * 86400000));
  await expect(readFile(stored.storagePath!)).rejects.toThrow();
  expect((await statementRows(h.db, f.ownerId, statement.id))[0].journalEntryId).toBeTruthy();
  expect(
    (await uploadStatement(h.db, f.ownerId, { bytes: bytes(amex()), filename: "again.csv" }, config)).id,
  ).toBe(statement.id);
});
it("statement ending balance creates an idempotent published observation and no entries", async () => {
  const statement = await upload(amex());
  await h.db
    .update(statements)
    .set({ periodEnd: "2026-10-01", summary: { ending_balance: "-200.0000" } })
    .where(eq(statements.id, statement.id));
  const first = await observeStatementBalance(h.db, f.ownerId, statement.id);
  const again = await observeStatementBalance(h.db, f.ownerId, statement.id);
  expect(first.id).toBe(again.id);
  expect(first.source).toBe("statement");
  expect(first.status).toBe("published");
  expect(first.items[0].balanceNative).toBe("-200.0000");
  expect(await h.db.select().from(journalEntries)).toHaveLength(0);
});

it("stores only decrypted PDF bytes and deduplicates the original upload before unlocking again", async () => {
  const original = new Uint8Array(
    await readFile("../../services/statement-parser/tests/fixtures/encrypted.pdf"),
  );
  const decrypted = new Uint8Array(
    await readFile("../../services/statement-parser/tests/fixtures/usbank-card.pdf"),
  );
  const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
    expect((options.body as FormData).get("password")).toBe("synthetic-password");
    return new Response(decrypted, { headers: { "X-Page-Count": "4" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  try {
    const statement = await uploadStatement(
      h.db,
      f.ownerId,
      { bytes: original, filename: "encrypted.pdf", password: "synthetic-password" },
      { ...config, PARSER_URL: "http://parser.invalid" },
    );
    const [stored] = await h.db.select().from(statements).where(eq(statements.id, statement.id));
    expect(new Uint8Array(await readFile(stored.storagePath!))).toEqual(decrypted);
    expect(JSON.stringify(stored)).not.toContain("synthetic-password");
    expect(
      (await uploadStatement(h.db, f.ownerId, { bytes: original, filename: "again.pdf" }, config)).id,
    ).toBe(statement.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
