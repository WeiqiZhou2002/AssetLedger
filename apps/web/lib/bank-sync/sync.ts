import { and, desc, eq, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { AppDb } from "@/db/types";
import { bankConnections, importRows, statements, categories, importJobs, bankSyncRuns } from "@/db/schema";
import { money } from "@/lib/money";
import { invariant, LedgerError } from "@/lib/ledger/errors";
import { ensureDefaultCategories } from "@/lib/ledger/categories";
import { auditLedger } from "@/lib/ledger/audit";
import { importLock } from "@/lib/imports/store";
import { normalizeMerchant, maskDigits, sha256 } from "@/lib/imports/text";
import { refreshOwnerSuggestions } from "@/lib/imports/suggestions";
import type { BankClient, BankTransaction, Holdings, PlaidConfig, SyncPage } from "./types";
import {
  connectionAccounts,
  requireConnection,
  storeAccounts,
  token,
  recordConnectionFailure,
  type Connection,
} from "./connections";
import { classifyTransaction } from "./classification";
export { classifyTransaction } from "./classification";
import { observeBalances, ownerSyncDate } from "./observations";
import { completeBackfill } from "./backfill";
import { effectiveFromDate } from "./date-range";
import { syncCounts } from "./run-counts";
import { autoPostOwnerRows } from "./auto-post";
import { CORE_SWEEP_NOTE, isCoreSweep } from "./core-sweeps";
type SyncBatch = Omit<SyncPage, "hasMore">;
export async function collectSync(
  client: BankClient,
  accessToken: string,
  originalCursor: string | null,
): Promise<SyncBatch | null> {
  // Every retry starts from the original committed cursor, never a partial-page cursor.
  for (let restart = 0; restart <= 3; restart++) {
    let cursor = originalCursor;
    const batch: SyncBatch = {
      accounts: [],
      added: [],
      modified: [],
      removed: [],
      nextCursor: "",
      updateStatus: "NOT_READY",
    };
    try {
      for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
        const page = await client.sync(accessToken, cursor);
        if (!page.nextCursor || page.updateStatus === "NOT_READY") return null;
        batch.added.push(...page.added);
        batch.modified.push(...page.modified);
        batch.removed.push(...page.removed);
        const accounts = new Map(batch.accounts.map((row) => [row.id, row]));
        for (const row of page.accounts) accounts.set(row.id, row);
        batch.accounts = [...accounts.values()];
        batch.nextCursor = page.nextCursor;
        batch.updateStatus = page.updateStatus;
        if (!page.hasMore) return batch;
        invariant(page.nextCursor !== cursor, "Plaid 分页游标未前进");
        cursor = page.nextCursor;
      }
      throw new Error("pagination_limit");
    } catch (error) {
      if (restart === 3) throw error;
    }
  }
  return null;
}
export function signedPlaidAmount(value: string) {
  return money(value).negated().toFixed(4);
}
function sanitized(row: BankTransaction) {
  return {
    transactionId: row.id,
    accountId: row.accountId,
    amount: signedPlaidAmount(row.amount),
    postedDate: row.date,
    transactionDate: row.authorizedDate ?? row.date,
    name: maskDigits(row.name),
    description: maskDigits(row.originalDescription ?? row.name),
    merchant: maskDigits(row.merchantName ?? row.name),
    currency: row.currency,
    pending: row.pending,
    primary: row.primary,
    detailed: row.detailed,
  };
}
async function dailyContainer(db: AppDb, ownerId: string, connection: Connection, date: string) {
  const [row] = await db
    .insert(statements)
    .values({
      ownerId,
      source: "plaid",
      connectionId: connection.id,
      syncDate: date,
      title: `Plaid · ${connection.institutionName} · ${date}`,
      status: "needs_review",
      issuer: connection.institutionName,
      parser: "plaid",
      parserVersion: "1",
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [existing] = await db
    .select()
    .from(statements)
    .where(
      and(
        eq(statements.ownerId, ownerId),
        eq(statements.connectionId, connection.id),
        eq(statements.syncDate, date),
      ),
    );
  return existing;
}
async function applySync(
  db: AppDb,
  ownerId: string,
  connection: Connection,
  batch: SyncBatch | null,
  holdings: Holdings | null,
  now: Date,
) {
  await ensureDefaultCategories(db, ownerId);
  const date = await ownerSyncDate(db, ownerId, now);
  const rows = [
    ...new Map(
      [...(batch?.accounts ?? []), ...(holdings?.accounts ?? [])].map((row) => [row.id, row]),
    ).values(),
  ];
  await storeAccounts(db, ownerId, connection.id, rows, now);
  const mapped = await connectionAccounts(db, ownerId, connection.id);
  const counts = {
    added: 0,
    modified: 0,
    removed: 0,
    pendingSkipped: 0,
    coreSweepSkipped: 0,
    beforeStartSkipped: 0,
    currencySkipped: 0,
    unmappedSkipped: 0,
    loanTransactionsSkipped: 0,
  };
  const touched = new Set<string>();
  let container: typeof statements.$inferSelect | null = batch
    ? await dailyContainer(db, ownerId, connection, date)
    : null;
  let rowIndex = container
    ? Math.max(
        -1,
        ...(
          await db
            .select({ index: importRows.rowIndex })
            .from(importRows)
            .where(and(eq(importRows.ownerId, ownerId), eq(importRows.statementId, container.id)))
        ).map((row) => row.index),
      )
    : -1;
  for (const [kind, transactions] of [
    ["added", batch?.added ?? []],
    ["modified", batch?.modified ?? []],
  ] as const) {
    for (const transaction of transactions) {
      const [existing] = await db
        .select()
        .from(importRows)
        .where(
          and(
            eq(importRows.ownerId, ownerId),
            eq(importRows.bankConnectionId, connection.id),
            eq(importRows.providerTransactionId, transaction.id),
          ),
        );
      if (existing && kind === "added") continue;
      const payload = sanitized(transaction);
      // Old payloads omitted name; adding it alone must not replace an unchanged entry.
      const comparablePayload = { ...payload } as Partial<typeof payload>;
      if (existing?.upstreamPayload?.name === undefined) delete comparablePayload.name;
      if (existing && kind === "modified" && isDeepStrictEqual(existing.upstreamPayload, comparablePayload))
        continue;
      if (
        existing &&
        (existing.journalEntryId || existing.linkedEntryId) &&
        existing.autoPostState !== "duplicate"
      ) {
        await db
          .update(importRows)
          .set({ upstreamState: "modified", upstreamPayload: payload })
          .where(and(eq(importRows.ownerId, ownerId), eq(importRows.id, existing.id)));
        await auditLedger(db, ownerId, "import_row", existing.id, "bank.upstream_modified");
        counts.modified++;
        continue;
      }
      const account = mapped.find((row) => row.plaidAccountId === transaction.accountId);
      const coreSweep = isCoreSweep(
        `${transaction.name} ${transaction.originalDescription ?? ""} ${transaction.merchantName ?? ""}`,
      );
      let skipped = false;
      if (account?.type === "loan") {
        counts.loanTransactionsSkipped++;
        skipped = true;
      } else if (transaction.pending) {
        counts.pendingSkipped++;
        skipped = true;
      } else if (coreSweep) {
        counts.coreSweepSkipped++;
        skipped = true;
      } else if (transaction.date < effectiveFromDate(connection, account)) {
        counts.beforeStartSkipped++;
        skipped = true;
      } else if (!transaction.currency || account?.currency !== transaction.currency) {
        counts.currencySkipped++;
        skipped = true;
      } else if (!account?.isEnabled || !account.accountId || account.type === "investment") {
        counts.unmappedSkipped++;
        skipped = true;
      }
      if (skipped) {
        if (existing)
          await db
            .update(importRows)
            .set({
              upstreamState: "modified",
              upstreamPayload: payload,
              decision: "exclude",
              softNotes: [coreSweep ? CORE_SWEEP_NOTE : "上游变更后不再符合导入范围"],
              ...(coreSweep
                ? {
                    autoPostState: "resolved" as const,
                    duplicateCandidateRowIds: [],
                    duplicateCandidateEntryIds: [],
                  }
                : {}),
            })
            .where(and(eq(importRows.ownerId, ownerId), eq(importRows.id, existing.id)));
        continue;
      }
      invariant(account?.accountId && transaction.currency, "账户映射无效");
      const suggested = classifyTransaction(transaction, account.type);
      const values = {
        ...(existing?.autoPostState === "duplicate"
          ? { linkedEntryId: null, autoPostState: "none" as const }
          : {}),
        accountId: account.accountId,
        bankConnectionId: connection.id,
        source: "plaid" as const,
        sourceRowText: payload.description,
        descriptionRaw: payload.description,
        merchantNormalized: normalizeMerchant(payload.merchant),
        amountRaw: payload.amount,
        amount: payload.amount,
        currency: transaction.currency,
        transactionDate: payload.transactionDate,
        postedDate: payload.postedDate,
        direction: suggested.direction,
        suggestedEntryType: suggested.type,
        suggestedCategoryId: null,
        confidence: "0.900",
        providerTransactionId: transaction.id,
        rowSignature: sha256(`${connection.id}:${transaction.id}`),
        upstreamState: kind === "modified" ? ("modified" as const) : ("none" as const),
        upstreamPayload: payload,
        decision: "pending" as const,
        reviewedAt: null,
        decisionPayload: {},
        duplicateResolution: "none" as const,
        suggestedCounterAccountId: null,
        softNotes: [],
      };
      if (existing) {
        await db
          .update(importRows)
          .set(values)
          .where(and(eq(importRows.ownerId, ownerId), eq(importRows.id, existing.id)));
        touched.add(existing.statementId);
        await auditLedger(db, ownerId, "import_row", existing.id, "bank.row_modified");
        counts.modified++;
      } else {
        if (!container) {
          container = await dailyContainer(db, ownerId, connection, date);
          const prior = await db
            .select({ index: importRows.rowIndex })
            .from(importRows)
            .where(and(eq(importRows.ownerId, ownerId), eq(importRows.statementId, container.id)));
          rowIndex = Math.max(-1, ...prior.map((row) => row.index));
        }
        await db
          .insert(importRows)
          .values({ ownerId, statementId: container.id, rowIndex: ++rowIndex, ...values });
        touched.add(container.id);
        counts.added++;
      }
    }
  }
  for (const providerId of batch?.removed ?? []) {
    const [row] = await db
      .select()
      .from(importRows)
      .where(
        and(
          eq(importRows.ownerId, ownerId),
          eq(importRows.bankConnectionId, connection.id),
          eq(importRows.providerTransactionId, providerId),
        ),
      );
    if (!row || row.upstreamPayload?.removed === true) continue;
    const approved = row.journalEntryId || row.linkedEntryId;
    await db
      .update(importRows)
      .set({
        upstreamState: "removed",
        upstreamPayload: { transactionId: providerId, removed: true },
        softNotes: [...new Set([...row.softNotes, "上游已删除"])],
        ...(!approved ? { decision: "exclude" as const } : {}),
      })
      .where(and(eq(importRows.ownerId, ownerId), eq(importRows.id, row.id)));
    await auditLedger(db, ownerId, "import_row", row.id, "bank.upstream_removed");
    counts.removed++;
  }
  for (const id of touched)
    await db
      .update(statements)
      .set({ status: "needs_review" })
      .where(and(eq(statements.ownerId, ownerId), eq(statements.id, id)));
  await refreshOwnerSuggestions(db, ownerId);
  // Merchant history wins; PFC is a fallback suggestion, never an approval.
  const categoryRows = await db
    .select()
    .from(categories)
    .where(and(eq(categories.ownerId, ownerId), eq(categories.isArchived, false)));
  for (const transaction of [...(batch?.added ?? []), ...(batch?.modified ?? [])]) {
    const [row] = await db
      .select()
      .from(importRows)
      .where(
        and(
          eq(importRows.ownerId, ownerId),
          eq(importRows.bankConnectionId, connection.id),
          eq(importRows.providerTransactionId, transaction.id),
        ),
      );
    if (!row || row.suggestedCategoryId || row.journalEntryId || row.linkedEntryId) continue;
    const account = mapped.find((account) => account.plaidAccountId === transaction.accountId);
    const suggested = classifyTransaction(transaction, account?.type ?? "");
    const category = categoryRows.find(
      (category) =>
        category.name === suggested.category &&
        category.kind ===
          (suggested.type === "income" || (suggested.type === "interest" && money(transaction.amount).lt(0))
            ? "income"
            : "expense"),
    );
    if (category)
      await db
        .update(importRows)
        .set({ suggestedCategoryId: category.id })
        .where(and(eq(importRows.ownerId, ownerId), eq(importRows.id, row.id)));
  }
  const observation = await observeBalances(db, ownerId, connection.id, mapped, rows, holdings, now);
  if (container)
    await db
      .update(statements)
      .set({
        diagnostics: [
          ...Object.entries(counts)
            .filter(([, count]) => count > 0)
            .map(([kind, count]) => ({ kind, count, severity: "info" as const })),
          ...(observation.missingFx
            ? [{ kind: "missing_fx_draft_observation", severity: "warning" as const }]
            : []),
        ],
      })
      .where(and(eq(statements.ownerId, ownerId), eq(statements.id, container.id)));
  return { ...counts, ...observation };
}
export async function syncConnection(
  db: AppDb,
  ownerId: string,
  id: string,
  client: BankClient,
  config: PlaidConfig,
  now = new Date(),
  job?: typeof importJobs.$inferSelect,
) {
  invariant(config.PLAID_ENABLED === "true", "银行连接未启用", 404);
  const connection = await requireConnection(db, ownerId, id);
  invariant(
    ["active", "consent_expiring"].includes(connection.status) && connection.mappingConfirmedAt,
    "连接未就绪",
  );
  invariant(!job || job.syncGeneration === connection.syncGeneration, "同步任务代次已过期", 409);
  const accessToken = token(connection, config);
  const run = await db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const current = await requireConnection(tx, ownerId, id);
    invariant(current.syncGeneration === connection.syncGeneration, "同步代次已改变", 409);
    const [prior] = await tx
      .select()
      .from(bankSyncRuns)
      .where(
        and(
          eq(bankSyncRuns.ownerId, ownerId),
          eq(bankSyncRuns.connectionId, id),
          ...(job?.syncRunId
            ? [eq(bankSyncRuns.id, job.syncRunId)]
            : [
                eq(bankSyncRuns.kind, "backfill"),
                eq(bankSyncRuns.effectiveFromDate, current.importFromDate),
                sql`${bankSyncRuns.status} in ('queued', 'running', 'not_ready', 'failed')`,
              ]),
        ),
      )
      .orderBy(desc(bankSyncRuns.startedAt))
      .limit(1);
    if (prior && (job?.syncRunId || current.backfillPlan)) {
      await tx
        .update(bankSyncRuns)
        .set({ status: "running", finishedAt: null })
        .where(and(eq(bankSyncRuns.ownerId, ownerId), eq(bankSyncRuns.id, prior.id)));
      return prior;
    }
    const [created] = await tx
      .insert(bankSyncRuns)
      .values({
        ownerId,
        connectionId: id,
        jobId: job?.id,
        kind: "sync",
        status: "running",
        startedAt: now,
        effectiveFromDate: current.importFromDate,
        counts: syncCounts(),
      })
      .returning();
    return created;
  });
  const finish = async (status: "not_ready" | "failed", updateStatus: string | null = null) =>
    db.transaction(async (tx) => {
      await importLock(tx, ownerId);
      const current = await requireConnection(tx, ownerId, id);
      if (current.syncGeneration !== connection.syncGeneration) return;
      await tx
        .update(bankSyncRuns)
        .set({ status, updateStatus, finishedAt: now })
        .where(
          and(
            eq(bankSyncRuns.ownerId, ownerId),
            eq(bankSyncRuns.id, run.id),
            eq(bankSyncRuns.status, "running"),
          ),
        );
    });
  try {
    const batch = connection.products.includes("transactions")
      ? await collectSync(client, accessToken, connection.transactionsCursor)
      : null;
    if (connection.products.includes("transactions") && !batch) {
      await finish("not_ready", "NOT_READY");
      return { notReady: true, awaitingHistory: Boolean(connection.backfillPlan) };
    }
    const cached = await client.accounts(accessToken);
    invariant(cached.item.id === connection.plaidItemId, "Plaid Item 不匹配");
    if (batch && !batch.accounts.length) batch.accounts = cached.accounts;
    const holdings = connection.products.includes("investments") ? await client.holdings(accessToken) : null;
    const consent = cached.item.consentExpiresAt ? new Date(cached.item.consentExpiresAt) : null;
    return await db.transaction(async (tx) => {
      await importLock(tx, ownerId);
      if (job) {
        const [lease] = await tx
          .select()
          .from(importJobs)
          .where(and(eq(importJobs.ownerId, ownerId), eq(importJobs.id, job.id)))
          .for("update");
        invariant(
          lease?.status === "running" && lease.lockedBy === job.lockedBy && lease.attempts === job.attempts,
          "同步任务已由其他 worker 接管",
          409,
        );
      }
      const current = await requireConnection(tx, ownerId, id);
      invariant(
        current.status !== "revoked" &&
          current.syncGeneration === connection.syncGeneration &&
          current.transactionsCursor === connection.transactionsCursor,
        "同步状态已改变，请重试",
        409,
      );
      const duplicateCount = async () =>
        (
          await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(importRows)
            .where(
              and(
                eq(importRows.ownerId, ownerId),
                eq(importRows.bankConnectionId, id),
                eq(importRows.autoPostState, "duplicate"),
              ),
            )
        )[0].count;
      const duplicatesBefore = await duplicateCount();
      const result = await applySync(tx, ownerId, current, batch, holdings, now);
      await autoPostOwnerRows(tx, ownerId, config.PLAID_ENV, now);
      await tx
        .update(bankConnections)
        .set({
          transactionsCursor: batch?.nextCursor ?? current.transactionsCursor,
          lastSyncedAt: now,
          lastSuccessAt: now,
          errorCode: result.missingCurrencies.length
            ? `MISSING_FX_${result.missingCurrencies.join("_")}`
            : null,
          consentExpiresAt: consent,
          status:
            consent && consent.getTime() <= now.getTime() + 7 * 86400000 ? "consent_expiring" : "active",
        })
        .where(and(eq(bankConnections.ownerId, ownerId), eq(bankConnections.id, id)));
      const counts = syncCounts({
        fetched_added: batch?.added.length ?? 0,
        fetched_modified: batch?.modified.length ?? 0,
        fetched_removed: batch?.removed.length ?? 0,
        imported: result.added,
        duplicates_linked: Math.max(0, (await duplicateCount()) - duplicatesBefore),
        before_start_skipped: result.beforeStartSkipped,
        pending_skipped: result.pendingSkipped,
        core_sweep_skipped: result.coreSweepSkipped,
        unmapped_skipped: result.unmappedSkipped + result.loanTransactionsSkipped,
        currency_skipped: result.currencySkipped,
      });
      const awaitingHistory = Boolean(
        current.backfillPlan &&
        batch?.updateStatus !== "HISTORICAL_UPDATE_COMPLETE" &&
        current.products.includes("transactions"),
      );
      if (current.backfillPlan && !awaitingHistory)
        await completeBackfill(tx, ownerId, await requireConnection(tx, ownerId, id));
      // A backfill may span INITIAL and HISTORICAL updates; preserve its aggregate counts.
      const totals =
        run.kind === "backfill"
          ? syncCounts(
              Object.fromEntries(
                Object.entries(counts).map(([key, value]) => [
                  key,
                  value + (run.counts[key as keyof typeof counts] ?? 0),
                ]),
              ),
            )
          : counts;
      await tx
        .update(bankSyncRuns)
        .set({
          status: awaitingHistory ? "not_ready" : "succeeded",
          finishedAt: now,
          updateStatus: batch?.updateStatus ?? null,
          counts: totals,
        })
        .where(and(eq(bankSyncRuns.ownerId, ownerId), eq(bankSyncRuns.id, run.id)));
      await auditLedger(tx, ownerId, "bank_connection", id, "bank.sync", counts);
      return { notReady: false, awaitingHistory, ...result };
    });
  } catch (error) {
    await finish("failed");
    if (!(error instanceof LedgerError && error.status === 409))
      await recordConnectionFailure(db, ownerId, id, error, now, connection.syncGeneration);
    throw error;
  }
}
