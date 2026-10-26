import { and, eq } from "drizzle-orm";
import { accounts, csvMappings, importRows, institutions, statements } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { invariant } from "@/lib/ledger/errors";
import { requireAccount } from "@/lib/ledger/accounts";
import { parseCsv, inspectCsv } from "./csv";
import type { ParsedRow, StatementResult } from "./contracts";
import { readStoredFile } from "./files";
import { findCsvMapping, type ImportConfig } from "./service";
import { ParserClient } from "./parser";
import { normalizeMerchant, maskDigits, sha256 } from "./text";
import { requireStatement, statementRows } from "./store";
import { refreshOwnerSuggestions, suggestedType } from "./suggestions";
export async function parseStatement(
  db: AppDb,
  ownerId: string,
  id: string,
  config: ImportConfig,
): Promise<{
  parsed: StatementResult | null;
  csv?: {
    headers: string[];
    headerSignature: string;
    skipRows: number;
    mapping?: import("./types").CsvMapping;
    accountId?: string;
  };
}> {
  const statement = await requireStatement(db, ownerId, id);
  invariant(statement.storagePath, "原件已删除");
  const bytes = await readStoredFile(config.DATA_DIR, statement.storagePath);
  if (statement.mime === "application/pdf")
    return {
      parsed: await new ParserClient(config.PARSER_URL, config.MAX_UPLOAD_MB * 1024 * 1024).parse(bytes),
    };
  const headers = inspectCsv(bytes);
  const mapping = statement.accountId ? await findCsvMapping(db, ownerId, statement.accountId, bytes) : null;
  if (!mapping || !statement.accountId) return { parsed: null, csv: headers };
  const account = await requireAccount(db, ownerId, statement.accountId);
  const parsed = parseCsv(bytes, mapping, account);
  return {
    csv: {
      ...headers,
      headers: parsed.headers,
      headerSignature: parsed.headerSignature,
      skipRows: mapping.skipRows,
      mapping,
      accountId: account.id,
    },
    parsed: {
      statement_type: account.type === "liability_credit_card" ? "credit_card" : "bank",
      currency: account.currency,
      page_count: 1,
      parser: "csv",
      parser_version: "1.0.0",
      entries: parsed.entries,
      summary: {},
      diagnostics: [],
      transaction_lines: [],
    },
  };
}
export async function applyParsedOutcome(
  db: AppDb,
  ownerId: string,
  id: string,
  outcome: Awaited<ReturnType<typeof parseStatement>>,
) {
  if (outcome.csv) {
    const csv = outcome.csv;
    const statement = await requireStatement(db, ownerId, id);
    await db
      .update(statements)
      .set({
        status: "needs_mapping",
        summary: {
          ...statement.summary,
          csv_headers: csv.headers,
          header_signature: csv.headerSignature,
          csv_skip_rows: csv.skipRows,
        },
      })
      .where(and(eq(statements.ownerId, ownerId), eq(statements.id, id)));
    if (csv.mapping && csv.accountId)
      await db
        .insert(csvMappings)
        .values({
          ownerId,
          accountId: csv.accountId,
          name: "自动识别 / 已保存映射",
          headerSignature: csv.headerSignature,
          mapping: csv.mapping,
        })
        .onConflictDoNothing();
  }
  if (outcome.parsed) await applyParsedStatement(db, ownerId, id, outcome.parsed);
}
export async function storeParsedRows(
  db: AppDb,
  ownerId: string,
  statementId: string,
  rows: ParsedRow[],
  source: "parser" | "csv" | "ai",
  offset = 0,
) {
  if (!rows.length) return;
  await db.insert(importRows).values(
    rows.map((row, index) => ({
      ownerId,
      statementId,
      rowIndex: index + offset,
      source,
      sourcePage: row.source_page,
      sourceRowText: maskDigits(row.source_row_text),
      transactionDate: row.transaction_date,
      postedDate: row.posted_date,
      descriptionRaw: maskDigits(row.description_raw),
      merchantNormalized: normalizeMerchant(row.merchant_normalized || row.description_raw),
      amountRaw: row.amount_raw,
      amount: row.amount,
      currency: row.currency,
      direction: row.direction,
      confidence: row.confidence,
      providerTransactionId: row.provider_transaction_id,
      suggestedEntryType: suggestedType(row.direction),
      rowSignature: sha256(
        JSON.stringify([
          row.transaction_date,
          row.posted_date,
          row.amount,
          normalizeMerchant(row.description_raw),
          row.provider_transaction_id,
        ]),
      ),
    })),
  );
}
export async function applyParsedStatement(db: AppDb, ownerId: string, id: string, parsed: StatementResult) {
  const statement = await requireStatement(db, ownerId, id);
  invariant(
    !(await statementRows(db, ownerId, id)).some((row) => row.journalEntryId || row.linkedEntryId),
    "账单已部分入账，不能重新解析",
  );
  let accountId = statement.accountId;
  if (!accountId && parsed.account_last4) {
    const candidates = await db
      .select({ account: accounts, institution: institutions })
      .from(accounts)
      .leftJoin(
        institutions,
        and(eq(institutions.id, accounts.institutionId), eq(institutions.ownerId, ownerId)),
      )
      .where(
        and(
          eq(accounts.ownerId, ownerId),
          eq(accounts.last4, parsed.account_last4),
          eq(accounts.currency, parsed.currency),
          eq(accounts.isActive, true),
        ),
      );
    const matches = candidates.filter(
      ({ account, institution }) =>
        (parsed.statement_type === "credit_card"
          ? account.type === "liability_credit_card"
          : ["asset_cash", "asset_brokerage_cash"].includes(account.type)) &&
        (!parsed.issuer ||
          !institution ||
          normalizeMerchant(institution.name).includes(normalizeMerchant(parsed.issuer))),
    );
    if (matches.length === 1) accountId = matches[0].account.id;
  }
  if (accountId) {
    const account = await requireAccount(db, ownerId, accountId);
    invariant(account.currency === parsed.currency, "解析币种与账户不符");
    invariant(
      parsed.statement_type !== "credit_card" || account.type === "liability_credit_card",
      "账单账户类型不符",
    );
  }
  await db.delete(importRows).where(and(eq(importRows.ownerId, ownerId), eq(importRows.statementId, id)));
  await storeParsedRows(db, ownerId, id, parsed.entries, parsed.parser === "csv" ? "csv" : "parser");
  await db
    .update(statements)
    .set({
      accountId,
      status: accountId ? "needs_review" : "needs_mapping",
      statementType: parsed.statement_type,
      issuer: parsed.issuer,
      accountLast4: parsed.account_last4,
      periodStart: parsed.statement_start,
      periodEnd: parsed.statement_end,
      currency: parsed.currency,
      pageCount: statement.mime === "application/pdf" ? parsed.page_count : null,
      summary: { ...statement.summary, ...parsed.summary },
      parser: parsed.parser,
      parserVersion: parsed.parser_version,
      diagnostics: parsed.diagnostics,
      transactionLines: parsed.transaction_lines.map((line) => ({ ...line, text: maskDigits(line.text) })),
    })
    .where(and(eq(statements.ownerId, ownerId), eq(statements.id, id)));
  await refreshOwnerSuggestions(db, ownerId);
}
