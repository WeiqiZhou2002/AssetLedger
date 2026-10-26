import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "@/db/types";
import {
  accounts,
  bankConnections,
  bankConnectionAccounts,
  bankSyncRuns,
  importJobs,
  importRows,
  journalEntries,
  postings,
  statements,
} from "@/db/schema";
import { dateSchema } from "@/lib/ledger/schemas";
import { invariant } from "@/lib/ledger/errors";
import { importLock } from "@/lib/imports/store";
import { auditLedger } from "@/lib/ledger/audit";
import { getEntry, replaceEntry, voidEntry } from "@/lib/ledger/entries";
import { buildPostings } from "@/lib/ledger/builders";
import { money } from "@/lib/money";
import { requireConnection, connectionAccounts, type Connection } from "./connections";
import { ownerSyncDate } from "./observations";
import { shiftDate, backfillDefault, historyStart, availabilityStart } from "./date-range";
import { syncCounts } from "./run-counts";
import { fingerprint } from "./auto-state";
import { openingBalanceSuggestions } from "./opening-balances";
import type { PlaidConfig } from "./types";
import type { BackfillState } from "./backfill-types";

const backfillInput = z
  .object({
    from: dateSchema.optional(),
    actions: z
      .array(z.object({ accountId: z.uuid(), action: z.enum(["keep", "recalculate", "exclude"]) }).strict())
      .default([]),
  })
  .strict();

export async function planBackfill(
  db: AppDb,
  ownerId: string,
  id: string,
  config: PlaidConfig,
  input: unknown,
  now = new Date(),
) {
  const parsed = backfillInput.parse(input);
  const connection = await requireConnection(db, ownerId, id);
  invariant(
    config.PLAID_ENABLED === "true" && connection.environment === config.PLAID_ENV,
    "连接环境不符",
    404,
  );
  invariant(connection.status === "active" && connection.mappingConfirmedAt, "连接须为活跃状态且已确认映射");
  const today = await ownerSyncDate(db, ownerId, now);
  const value = { ...parsed, from: parsed.from ?? backfillDefault(config, today, connection.importFromDate) };
  invariant(
    value.from <= connection.importFromDate && value.from >= shiftDate(today, -730) && value.from <= today,
    "补导日期须不晚于当前起始日，且在本地今天之前的 730 天内",
  );
  const mappings = (await connectionAccounts(db, ownerId, id)).filter((row) => row.accountId);
  invariant(mappings.length > 0, "请先完成账户映射");
  invariant(new Set(value.actions.map((row) => row.accountId)).size === value.actions.length, "账户操作重复");
  invariant(
    value.actions.every((action) => mappings.some((row) => row.accountId === action.accountId)),
    "账户不属于此连接",
    404,
  );
  const ledgerAccounts = await db.select().from(accounts).where(eq(accounts.ownerId, ownerId));
  const jobs = await db
    .select({ id: importJobs.id, status: importJobs.status })
    .from(importJobs)
    .where(
      and(
        eq(importJobs.ownerId, ownerId),
        eq(importJobs.connectionId, id),
        inArray(importJobs.status, ["queued", "running"]),
      ),
    );
  const mappedAccounts = [];
  for (const mapping of mappings) {
    const accountId = mapping.accountId!;
    const entries = await db
      .select({
        id: journalEntries.id,
        date: sql<string>`coalesce(${journalEntries.postedDate}, ${journalEntries.eventDate})`,
        status: journalEntries.status,
        type: journalEntries.entryType,
        source: journalEntries.source,
      })
      .from(journalEntries)
      .innerJoin(postings, and(eq(postings.journalEntryId, journalEntries.id), eq(postings.ownerId, ownerId)))
      .where(
        and(
          eq(journalEntries.ownerId, ownerId),
          eq(postings.accountId, accountId),
          inArray(journalEntries.status, ["draft", "confirmed"]),
        ),
      );
    const uniqueEntries = [...new Map(entries.map((entry) => [entry.id, entry])).values()];
    const openings = uniqueEntries
      .filter((entry) => entry.type === "opening_balance")
      .map(({ id, date, status }) => ({ id, date, status }));
    const conflicts = openings.filter((entry) => entry.date >= shiftDate(value.from, -1));
    const action = value.actions.find((item) => item.accountId === accountId)?.action ?? "keep";
    invariant(action !== "recalculate" || openings.length <= 1, "此账户有多笔有效期初，请先处理后再重算");
    invariant(
      action !== "recalculate" || (mapping.isEnabled && conflicts.length === 1),
      "重算须选择启用且有冲突期初的账户",
    );
    const evidence = await db
      .select({
        entryId: sql<string>`coalesce(${importRows.journalEntryId}, ${importRows.linkedEntryId})`,
        source: importRows.source,
      })
      .from(importRows)
      .where(and(eq(importRows.ownerId, ownerId), eq(importRows.accountId, accountId)));
    const counts = { manual: 0, pdf: 0, csv: 0, plaid: 0 };
    for (const entry of uniqueEntries.filter((entry) => entry.date >= value.from)) {
      const rows = evidence.filter((row) => row.entryId === entry.id);
      const source =
        entry.source !== "import"
          ? "manual"
          : rows.some((row) => row.source === "plaid")
            ? "plaid"
            : rows.some((row) => row.source === "csv")
              ? "csv"
              : "pdf";
      counts[source]++;
    }
    const pending = await db
      .select({ id: importRows.id })
      .from(importRows)
      .where(
        and(
          eq(importRows.ownerId, ownerId),
          eq(importRows.accountId, accountId),
          sql`(${importRows.autoPostState} in ('duplicate', 'upstream') or exists (select 1 from journal_entries e join postings p on p.journal_entry_id=e.id join accounts a on a.id=p.account_id where e.id=${importRows.journalEntryId} and e.owner_id=${ownerId} and p.owner_id=${ownerId} and a.owner_id=${ownerId} and e.status='confirmed' and e.transfer_match_id is null and a.type::text='transfer_clearing'))`,
        ),
      );
    const lastOpening = conflicts
      .map((entry) => entry.date)
      .sort()
      .at(-1);
    mappedAccounts.push({
      accountId,
      name: ledgerAccounts.find((row) => row.id === accountId)!.name,
      enabled: mapping.isEnabled,
      action,
      openings,
      conflict: conflicts.length > 0,
      effectiveFromDate: action === "keep" && lastOpening ? shiftDate(lastOpening, 1) : value.from,
      entries: counts,
      pending: pending.length,
    });
  }
  return {
    connectionId: id,
    currentFromDate: connection.importFromDate,
    targetFromDate: value.from,
    transactionsAvailable: connection.products.includes("transactions"),
    availabilityStart: availabilityStart(
      await ownerSyncDate(db, ownerId, connection.createdAt),
      connection.daysRequested,
    ),
    jobs,
    accounts: mappedAccounts,
  };
}

export async function executeBackfill(
  db: AppDb,
  ownerId: string,
  id: string,
  config: PlaidConfig,
  input: unknown,
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    await importLock(tx, ownerId);
    const plan = await planBackfill(tx, ownerId, id, config, input, now);
    const connection = await requireConnection(tx, ownerId, id);
    const state: BackfillState = {
      generation: connection.syncGeneration + 1,
      target: plan.targetFromDate,
      accounts: [],
    };
    for (const account of plan.accounts) {
      state.accounts.push({
        accountId: account.accountId,
        action: account.action,
        openings: await Promise.all(
          account.openings.map(async (entry) => ({
            id: entry.id,
            fingerprint: fingerprint(await getEntry(tx, ownerId, entry.id)),
          })),
        ),
      });
      await tx
        .update(bankConnectionAccounts)
        .set({
          importFromDate: account.effectiveFromDate,
          ...(account.action === "exclude" ? { isEnabled: false } : {}),
        })
        .where(
          and(
            eq(bankConnectionAccounts.ownerId, ownerId),
            eq(bankConnectionAccounts.connectionId, id),
            eq(bankConnectionAccounts.accountId, account.accountId),
          ),
        );
    }
    await tx
      .update(importJobs)
      .set({ status: "failed", errorKind: "SYNC_GENERATION_SUPERSEDED", lockedAt: null, lockedBy: null })
      .where(
        and(
          eq(importJobs.ownerId, ownerId),
          eq(importJobs.connectionId, id),
          inArray(importJobs.status, ["running", "queued"]),
        ),
      );
    await tx
      .update(bankSyncRuns)
      .set({ status: "superseded", finishedAt: now })
      .where(
        and(
          eq(bankSyncRuns.ownerId, ownerId),
          eq(bankSyncRuns.connectionId, id),
          inArray(bankSyncRuns.status, ["running", "queued", "not_ready"]),
        ),
      );
    await tx
      .update(bankConnections)
      .set({
        importFromDate: state.target,
        transactionsCursor: null,
        syncGeneration: state.generation,
        backfillPlan: state,
      })
      .where(and(eq(bankConnections.ownerId, ownerId), eq(bankConnections.id, id)));
    const [run] = await tx
      .insert(bankSyncRuns)
      .values({
        ownerId,
        connectionId: id,
        kind: "backfill",
        status: "queued",
        startedAt: now,
        effectiveFromDate: state.target,
        counts: syncCounts(),
      })
      .returning();
    const [job] = await tx
      .insert(importJobs)
      .values({
        ownerId,
        connectionId: id,
        kind: "plaid_sync",
        syncGeneration: state.generation,
        syncRunId: run.id,
        runAfter: now,
      })
      .returning();
    await tx
      .update(bankSyncRuns)
      .set({ jobId: job.id })
      .where(and(eq(bankSyncRuns.ownerId, ownerId), eq(bankSyncRuns.id, run.id)));
    await auditLedger(tx, ownerId, "bank_connection", id, "bank.backfill_requested", {
      generation: state.generation,
      target: state.target,
      actions: state.accounts.map(({ accountId, action }) => ({ accountId, action })),
    });
    return { ...plan, jobId: job.id, runId: run.id };
  });
}

// Called inside the batch transaction, only after historical completion and balances have been stored.
export async function completeBackfill(db: AppDb, ownerId: string, connection: Connection) {
  const plan = connection.backfillPlan;
  if (!plan) return;
  const mappings = await connectionAccounts(db, ownerId, connection.id);
  const recalculations = plan.accounts.filter((row) => row.action === "recalculate" && row.openings.length);
  const suggestions = await openingBalanceSuggestions(db, ownerId, [connection], mappings, {
    includeExisting: true,
    fromDate: plan.target,
  });
  // Defer all replacements together while any account still needs review or an observation.
  if (recalculations.some((choice) => !suggestions.some((row) => row.accountId === choice.accountId))) return;
  for (const choice of recalculations) {
    // Metadata edits also lock the entry; take that lock before checking its consent fingerprint.
    await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, choice.openings[0].id)))
      .for("update");
    // Normal entry creation takes SHARE on its accounts. Prevent a new opening racing this check.
    await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.ownerId, ownerId), eq(accounts.id, choice.accountId)))
      .for("update");
    const activeOpenings = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .innerJoin(postings, and(eq(postings.journalEntryId, journalEntries.id), eq(postings.ownerId, ownerId)))
      .where(
        and(
          eq(journalEntries.ownerId, ownerId),
          eq(postings.accountId, choice.accountId),
          eq(journalEntries.entryType, "opening_balance"),
          inArray(journalEntries.status, ["draft", "confirmed"]),
        ),
      );
    invariant(
      new Set(activeOpenings.map((row) => row.id)).size === 1 &&
        activeOpenings[0]?.id === choice.openings[0].id,
      "期初集合在补导确认后已改变，请重新预览补导",
      409,
    );
    const old = await getEntry(db, ownerId, choice.openings[0].id);
    invariant(
      fingerprint(old) === choice.openings[0].fingerprint,
      "期初余额在补导确认后已被修改，请重新预览补导",
      409,
    );
    const mapping = mappings.find((row) => row.accountId === choice.accountId);
    invariant(mapping?.isEnabled, "重算期初账户已停用，请重新预览补导", 409);
    const suggestion = suggestions.find((row) => row.accountId === choice.accountId)!;
    const sameOpening =
      old.eventDate === suggestion.eventDate &&
      (old.postedDate === null || old.postedDate === suggestion.eventDate) &&
      old.postings.some(
        (line) => line.accountId === choice.accountId && money(line.amount).eq(money(suggestion.amount)),
      );
    if (sameOpening) continue;
    if (money(suggestion.amount).isZero()) await voidEntry(db, ownerId, old.id, "补导历史后重算期初为零");
    else
      await replaceEntry(
        db,
        ownerId,
        old.id,
        await buildPostings(db, ownerId, "opening_balance", {
          toAccountId: choice.accountId,
          amount: suggestion.amount,
          eventDate: suggestion.eventDate,
          status: old.status === "draft" ? "draft" : "confirmed",
          notes: "所有者确认补导历史后重算期初",
        }),
        "补导历史后重算期初",
      );
    await auditLedger(db, ownerId, "journal_entry", old.id, "bank.backfill_opening_recalculated", {
      generation: plan.generation,
    });
  }
  await db
    .update(bankConnections)
    .set({ backfillPlan: null })
    .where(
      and(
        eq(bankConnections.ownerId, ownerId),
        eq(bankConnections.id, connection.id),
        eq(bankConnections.syncGeneration, plan.generation),
      ),
    );
}

export async function affectedConnections(db: AppDb, ownerId: string, config: PlaidConfig) {
  const connections = await db
    .select()
    .from(bankConnections)
    .where(
      and(
        eq(bankConnections.ownerId, ownerId),
        eq(bankConnections.environment, config.PLAID_ENV),
        eq(bankConnections.status, "active"),
      ),
    );
  const found = [];
  for (const connection of connections) {
    const reasons: string[] = [];
    const expected = historyStart(config, await ownerSyncDate(db, ownerId, connection.createdAt));
    if (connection.importFromDate > expected) reasons.push("起始日期晚于创建时的默认历史窗口");
    const [run] = await db
      .select()
      .from(bankSyncRuns)
      .where(and(eq(bankSyncRuns.ownerId, ownerId), eq(bankSyncRuns.connectionId, connection.id)))
      .orderBy(desc(bankSyncRuns.startedAt))
      .limit(1);
    if (run?.counts.imported === 0 && run.counts.before_start_skipped > 0)
      reasons.push("最近同步跳过历史且未新增");
    const containers = await db
      .select({ diagnostics: statements.diagnostics })
      .from(statements)
      .where(and(eq(statements.ownerId, ownerId), eq(statements.connectionId, connection.id)));
    if (
      containers.some(
        ({ diagnostics }) =>
          diagnostics.some((row) => row.kind === "beforeStartSkipped" && (row.count ?? 0) > 0) &&
          !diagnostics.some((row) => row.kind === "added" && (row.count ?? 0) > 0),
      )
    )
      reasons.push("旧同步诊断显示跳过历史且未新增");
    if (reasons.length) found.push({ connectionId: connection.id, reasons });
  }
  return found;
}
