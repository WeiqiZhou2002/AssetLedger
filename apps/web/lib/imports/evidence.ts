import { requireManualAccount } from "@/lib/ledger/balance-tracking";
import { lockOwnerStructure } from "@/lib/snapshots/groups";
import { ownerSyncDate } from "@/lib/bank-sync/observations";
import { and, eq, lte, sql } from "drizzle-orm";
import { readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AppDb } from "@/db/types";
import { balanceSnapshots, importJobs, snapshotItems, statements } from "@/db/schema";
import { invariant } from "@/lib/ledger/errors";
import { auditLedger } from "@/lib/ledger/audit";
import { createSnapshot, getSnapshot, updateSnapshot, publishSnapshot } from "@/lib/snapshots/service";
import { importLock, requireStatement } from "./store";
import { persistFile, readStoredFile, safeFile } from "./files";
import { ParserClient } from "./parser";
import type { ImportConfig } from "./service";
export async function renderStatementPage(
  db: AppDb,
  ownerId: string,
  id: string,
  page: number,
  config: ImportConfig,
) {
  const statement = await requireStatement(db, ownerId, id);
  invariant(
    statement.storagePath && statement.fileSha256 && statement.mime === "application/pdf",
    "PDF 原件不可用",
    404,
  );
  invariant(Number.isInteger(page) && page >= 1 && page <= (statement.pageCount ?? 0), "页码无效");
  const cache = join(resolve(config.DATA_DIR), "statements", statement.fileSha256, "pages", `${page}.png`);
  try {
    return new Uint8Array(await readFile(cache));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const png = await new ParserClient(config.PARSER_URL, config.MAX_UPLOAD_MB * 1024 * 1024).render(
    await readStoredFile(config.DATA_DIR, statement.storagePath),
    page,
  );
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`statement-file:${statement.fileSha256}`}))`,
    );
    const current = await requireStatement(tx, ownerId, id);
    if (current.storagePath) await persistFile(cache, png);
  });
  return png;
}
export async function deleteStatementFile(
  db: AppDb,
  ownerId: string,
  id: string,
  config: ImportConfig,
  discard = false,
) {
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const statement = await requireStatement(tx, ownerId, id);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`statement-file:${statement.fileSha256}`}))`,
    );
    await tx
      .update(importJobs)
      .set({ status: "failed", errorKind: "file_deleted", lockedAt: null, lockedBy: null })
      .where(
        and(
          eq(importJobs.ownerId, ownerId),
          eq(importJobs.statementId, id),
          sql`${importJobs.status} IN ('queued', 'running')`,
        ),
      );
    await tx
      .update(statements)
      .set({
        storagePath: null,
        deleteFileAfter: null,
        ...(discard
          ? { status: "discarded" as const }
          : ["queued", "parsing"].includes(statement.status)
            ? { status: "failed" as const }
            : {}),
      })
      .where(and(eq(statements.ownerId, ownerId), eq(statements.id, id)));
    if (statement.storagePath && statement.fileSha256) {
      // Physical content is hash-shared. This internal reference check reveals no other owner's data.
      const [references] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(statements)
        .where(eq(statements.storagePath, statement.storagePath));
      if (!references.count) {
        await rm(safeFile(config.DATA_DIR, statement.storagePath), { force: true });
        await rm(join(resolve(config.DATA_DIR), "statements", statement.fileSha256), {
          recursive: true,
          force: true,
        });
      }
    }
    await auditLedger(tx, ownerId, "statement", id, discard ? "statement.discard" : "statement.delete_file");
    return { ok: true };
  });
}
export async function retainFiles(db: AppDb, config: ImportConfig, now = new Date()) {
  const due = await db
    .select({ id: statements.id, ownerId: statements.ownerId })
    .from(statements)
    .where(
      and(
        eq(statements.source, "upload"),
        eq(statements.status, "approved"),
        lte(statements.deleteFileAfter, now),
      ),
    );
  for (const statement of due) await deleteStatementFile(db, statement.ownerId, statement.id, config);
  const directory = join(resolve(config.DATA_DIR), "legacy");
  const files = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  for (const file of files) {
    if (!file.isFile() || !/^[a-f0-9]{64}\.xlsx$/.test(file.name)) continue;
    const hash = file.name.slice(0, -5);
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`legacy-file:${hash}`}))`);
      // The guarded table retirement guarantees all legacy uploads are now unreferenced.
      await rm(join(directory, file.name), { force: true });
    });
  }
}
export async function observeStatementBalance(db: AppDb, ownerId: string, id: string) {
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const statement = await requireStatement(tx, ownerId, id);
    invariant(
      statement.accountId && statement.periodEnd && statement.summary.ending_balance !== undefined,
      "账单缺少账户、期末日期或期末余额",
    );
    invariant(!["queued", "parsing", "discarded"].includes(statement.status), "请先完成解析");
    await lockOwnerStructure(tx, ownerId);
    const account = await requireManualAccount(tx, ownerId, statement.accountId);
    invariant(statement.periodEnd <= (await ownerSyncDate(tx, ownerId, new Date())), "日期不能晚于今天");
    const sourceRef = `statement:${id}`;
    const [existing] = await tx
      .select({ id: balanceSnapshots.id })
      .from(balanceSnapshots)
      .innerJoin(
        snapshotItems,
        and(eq(snapshotItems.snapshotId, balanceSnapshots.id), eq(snapshotItems.ownerId, ownerId)),
      )
      .where(
        and(
          eq(balanceSnapshots.ownerId, ownerId),
          eq(snapshotItems.sourceRef, sourceRef),
          eq(snapshotItems.isCurrent, true),
        ),
      );
    const item = {
      accountId: account.id,
      balanceNative: statement.summary.ending_balance,
      currency: account.currency,
      sourceRef,
    };
    let snapshot;
    if (existing) {
      const previous = await getSnapshot(tx, ownerId, existing.id);
      snapshot = await updateSnapshot(tx, ownerId, previous.id, {
        expectedRevision: previous.revision,
        items: [
          ...previous.items
            .filter((row) => row.accountId !== account.id)
            .map(({ accountId, accountGroupId, balanceNative, currency, sourceRef, notes }) => ({
              accountId,
              accountGroupId,
              balanceNative,
              currency,
              sourceRef,
              notes,
            })),
          item,
        ],
      });
    } else {
      snapshot = await createSnapshot(tx, ownerId, {
        snapshotDate: statement.periodEnd,
        label: `${account.name} · 账单期末`,
        items: [item],
      });
      await tx
        .update(balanceSnapshots)
        .set({ source: "statement" })
        .where(and(eq(balanceSnapshots.ownerId, ownerId), eq(balanceSnapshots.id, snapshot.id)));
    }
    await auditLedger(tx, ownerId, "statement", id, "statement.observe", { snapshotId: snapshot.id });
    return publishSnapshot(tx, ownerId, snapshot.id);
  });
}
