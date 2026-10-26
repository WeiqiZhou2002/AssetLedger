import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "@/db/types";
import { csvMappings, importJobs, statements } from "@/db/schema";
import { requireAccount } from "@/lib/ledger/accounts";
import { auditLedger } from "@/lib/ledger/audit";
import { invariant } from "@/lib/ledger/errors";
import { csvMappingSchema } from "./contracts";
import { importedAccountSchema } from "./account-defaults";
import { createImportedAccount } from "./account-creation";
import { refreshOwnerSuggestions } from "./suggestions";
import { readCsv, inspectCsv, csvPreset } from "./csv";
import { persistFile, readStoredFile, safeFilename, storageFile } from "./files";
import { ParserClient } from "./parser";
import { sha256 } from "./text";
import { assertEditable, enqueue, importLock, requireStatement, statementRows } from "./store";
export type ImportConfig = {
  DATA_DIR: string;
  MAX_UPLOAD_MB: number;
  MAX_PDF_PAGES: number;
  PARSER_URL: string;
  FILE_RETENTION_DAYS: number;
};
export async function uploadStatement(
  db: AppDb,
  ownerId: string,
  input: { bytes: Uint8Array; filename: string; accountId?: string; password?: string },
  config: ImportConfig,
) {
  invariant(
    input.bytes.length > 0 && input.bytes.length <= config.MAX_UPLOAD_MB * 1024 * 1024,
    "文件超过大小限制",
  );
  const hash = sha256(input.bytes);
  const [existing] = await db
    .select()
    .from(statements)
    .where(and(eq(statements.ownerId, ownerId), eq(statements.fileSha256, hash)));
  if (existing) return publicStatement(existing);
  const account = input.accountId ? await requireAccount(db, ownerId, z.uuid().parse(input.accountId)) : null;
  invariant(!account?.isSystem, "请选择真实账户");
  const pdf = new TextDecoder().decode(input.bytes.slice(0, 5)) === "%PDF-";
  let bytes = input.bytes;
  let pageCount: number | null = null;
  if (pdf) {
    const unlocked = await new ParserClient(config.PARSER_URL, config.MAX_UPLOAD_MB * 1024 * 1024).unlock(
      bytes,
      input.password,
    );
    bytes = unlocked.bytes;
    pageCount = unlocked.pageCount;
    invariant(
      Number.isInteger(pageCount) && pageCount > 0 && pageCount <= config.MAX_PDF_PAGES,
      "PDF 页数超过限制",
    );
  } else inspectCsv(bytes);
  const path = storageFile(config.DATA_DIR, hash, pdf ? "pdf" : "csv");
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const [found] = await tx
      .select()
      .from(statements)
      .where(and(eq(statements.ownerId, ownerId), eq(statements.fileSha256, hash)));
    if (found) return publicStatement(found);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`statement-file:${hash}`}))`);
    await persistFile(path, bytes);
    const [statement] = await tx
      .insert(statements)
      .values({
        ownerId,
        accountId: account?.id,
        institutionId: account?.institutionId,
        fileSha256: hash,
        originalFilename: safeFilename(input.filename),
        mime: pdf ? "application/pdf" : "text/csv",
        sizeBytes: bytes.length,
        storagePath: path,
        pageCount,
        currency: account?.currency,
        statementType:
          account?.type === "liability_credit_card" ? "credit_card" : account ? "bank" : "unknown",
      })
      .returning();
    await enqueue(tx, ownerId, statement.id, pdf ? "pdf" : "csv");
    await auditLedger(tx, ownerId, "statement", statement.id, "statement.upload");
    return publicStatement(await requireStatement(tx, ownerId, statement.id));
  });
}
function publicStatement(row: typeof statements.$inferSelect) {
  const { storagePath, transactionLines, ...rest } = row;
  return { ...rest, fileAvailable: storagePath !== null, aiLineCount: transactionLines.length };
}
export async function listStatements(db: AppDb, ownerId: string) {
  return (
    await db
      .select()
      .from(statements)
      .where(eq(statements.ownerId, ownerId))
      .orderBy(desc(statements.createdAt))
  ).map(publicStatement);
}
export async function getStatementReview(db: AppDb, ownerId: string, id: string) {
  const statement = await requireStatement(db, ownerId, id);
  const [rows, jobs] = await Promise.all([
    statementRows(db, ownerId, id),
    db
      .select({
        id: importJobs.id,
        kind: importJobs.kind,
        status: importJobs.status,
        progress: importJobs.progress,
        attempts: importJobs.attempts,
        errorKind: importJobs.errorKind,
      })
      .from(importJobs)
      .where(and(eq(importJobs.ownerId, ownerId), eq(importJobs.statementId, id)))
      .orderBy(desc(importJobs.createdAt)),
  ]);
  return { statement: publicStatement(statement), rows, jobs };
}
export async function setStatementAccount(db: AppDb, ownerId: string, id: string, input: unknown) {
  const assignment = z
    .union([z.object({ accountId: z.uuid() }).strict(), z.object({ create: importedAccountSchema }).strict()])
    .parse(typeof input === "string" ? { accountId: input } : input);
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const statement = await assertEditable(tx, ownerId, id);
    invariant(statement.source === "upload", "Plaid 账户请在银行连接中映射");
    const rows = await statementRows(tx, ownerId, id);
    invariant(!rows.some((row) => row.journalEntryId || row.linkedEntryId), "已经有入账证据，不能更换账户");
    const account =
      "create" in assignment
        ? await createImportedAccount(
            tx,
            ownerId,
            {
              ...assignment.create,
              last4: assignment.create.last4 === undefined ? statement.accountLast4 : assignment.create.last4,
            },
            { name: statement.issuer ?? "未命名机构" },
          )
        : await requireAccount(tx, ownerId, assignment.accountId);
    const accountId = account.id;
    invariant(!account.isSystem && account.isActive, "请选择启用的真实账户");
    invariant(!statement.currency || account.currency === statement.currency, "账单与账户币种不一致");
    invariant(
      statement.statementType !== "credit_card" || account.type === "liability_credit_card",
      "信用卡账单需要信用卡账户",
    );
    invariant(
      statement.statementType !== "bank" || ["asset_cash", "asset_brokerage_cash"].includes(account.type),
      "银行账单需要现金账户",
    );
    await tx
      .update(statements)
      .set({
        accountId,
        institutionId: account.institutionId,
        currency: account.currency,
        status: "needs_review",
      })
      .where(and(eq(statements.ownerId, ownerId), eq(statements.id, id)));
    if (statement.mime === "text/csv") await enqueue(tx, ownerId, id, "csv");
    await refreshOwnerSuggestions(tx, ownerId);
    await auditLedger(tx, ownerId, "statement", id, "statement.account");
    return publicStatement(await requireStatement(tx, ownerId, id));
  });
}
export async function saveCsvMapping(
  db: AppDb,
  ownerId: string,
  id: string,
  input: unknown,
  config: ImportConfig,
) {
  const { name, mapping } = z
    .object({ name: z.string().trim().min(1).max(100), mapping: csvMappingSchema })
    .strict()
    .parse(input);
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const statement = await assertEditable(tx, ownerId, id);
    invariant(
      statement.mime === "text/csv" && statement.accountId && statement.storagePath,
      "请先指定 CSV 账户，并保留文件",
    );
    invariant(
      !(await statementRows(tx, ownerId, id)).some((row) => row.journalEntryId || row.linkedEntryId),
      "已部分入账，不能重新映射",
    );
    const data = readCsv(await readStoredFile(config.DATA_DIR, statement.storagePath), mapping.skipRows);
    const [saved] = await tx
      .insert(csvMappings)
      .values({
        ownerId,
        accountId: statement.accountId,
        name,
        mapping,
        headerSignature: data.headerSignature,
      })
      .onConflictDoUpdate({
        target: [csvMappings.ownerId, csvMappings.accountId, csvMappings.headerSignature],
        set: { name, mapping },
      })
      .returning();
    await tx
      .update(statements)
      .set({
        summary: { ...statement.summary, header_signature: data.headerSignature, csv_headers: data.headers },
      })
      .where(and(eq(statements.ownerId, ownerId), eq(statements.id, id)));
    await enqueue(tx, ownerId, id, "csv");
    await auditLedger(tx, ownerId, "statement", id, "statement.csv_mapping");
    return saved;
  });
}
export async function findCsvMapping(db: AppDb, ownerId: string, accountId: string, bytes: Uint8Array) {
  const mappings = await db
    .select()
    .from(csvMappings)
    .where(and(eq(csvMappings.ownerId, ownerId), eq(csvMappings.accountId, accountId)));
  for (const saved of mappings) {
    try {
      if (readCsv(bytes, saved.mapping.skipRows).headerSignature === saved.headerSignature)
        return saved.mapping;
    } catch {
      /* Try the next saved header layout. */
    }
  }
  const inspected = inspectCsv(bytes);
  const preset = csvPreset(inspected.headers);
  return preset ? { ...preset, skipRows: inspected.skipRows } : null;
}

export async function retryStatement(db: AppDb, ownerId: string, id: string) {
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const statement = await requireStatement(tx, ownerId, id);
    invariant(statement.status === "failed" && statement.storagePath, "当前账单不能重试");
    invariant(
      !(await statementRows(tx, ownerId, id)).some((row) => row.journalEntryId || row.linkedEntryId),
      "已部分入账，不能覆盖解析结果",
    );
    await auditLedger(tx, ownerId, "statement", id, "statement.retry");
    return enqueue(tx, ownerId, id, statement.mime === "text/csv" ? "csv" : "pdf");
  });
}
