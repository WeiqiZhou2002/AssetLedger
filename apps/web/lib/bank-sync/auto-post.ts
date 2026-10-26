import { detectBenefit } from "@/lib/benefits/config";
import { benefitInput } from "@/lib/benefits/input";
import { rescanBenefits } from "./benefit-rescan";
import { effectiveFromDate } from "./date-range";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "@/db/types";
import { bankConnections, bankConnectionAccounts, importRows, journalEntries, postings } from "@/db/schema";
import { createEntry, getEntry, replaceEntry, voidEntry } from "@/lib/ledger/entries";
import { buildPostings } from "@/lib/ledger/builders";
import { requireAccount } from "@/lib/ledger/accounts";
import { ensureDefaultCategories } from "@/lib/ledger/categories";
import { auditLedger } from "@/lib/ledger/audit";
import { invariant } from "@/lib/ledger/errors";
import { dateSchema } from "@/lib/ledger/schemas";
import { amountSchema, money } from "@/lib/money";
import { daysBetween } from "@/lib/money/fx";
import { normalizeMerchant, similarDescription } from "@/lib/imports/text";
import { updateApprovalStatus } from "@/lib/imports/approval";
import { classifyTransaction } from "./classification";
import { isCashAdvanceSpend, isCashDeposit, isTransferLike, isZelle } from "./transfer-config";
import { restoreTransferChoices } from "./transfer-restore";
import { clearingInput, matchUniqueLegs, unlinkLeg } from "./transfer-legs";
import { stampAutoEntry, untouched, updateAutoRow, type ImportRow } from "./auto-state";
import { categoryFor } from "./auto-category";
import { fallbackInput } from "./transfer-fallback";
import { CORE_SWEEP_NOTE, isCoreSweep } from "./core-sweeps";

const payloadSchema = z.object({
  transactionId: z.string(),
  accountId: z.string(),
  amount: amountSchema,
  postedDate: dateSchema,
  transactionDate: dateSchema,
  name: z.string().optional(),
  description: z.string(),
  merchant: z.string(),
  currency: z.string().nullable(),
  pending: z.boolean(),
  primary: z.string().nullable(),
  detailed: z.string().nullable(),
});
function classifyRow(row: ImportRow, accountType: string) {
  return classifyTransaction(
    {
      id: row.providerTransactionId ?? row.id,
      accountId: row.accountId ?? "",
      amount: money(row.amount).negated().toFixed(4),
      date: row.postedDate ?? row.transactionDate!,
      authorizedDate: row.transactionDate,
      name: row.descriptionRaw,
      originalDescription: row.descriptionRaw,
      merchantName: row.merchantNormalized,
      pending: false,
      pendingTransactionId: null,
      currency: row.currency,
      primary: typeof row.upstreamPayload?.primary === "string" ? row.upstreamPayload.primary : null,
      detailed: typeof row.upstreamPayload?.detailed === "string" ? row.upstreamPayload.detailed : null,
    },
    accountType === "liability_credit_card" ? "credit" : "depository",
  );
}
function transferLikeRow(row: ImportRow, accountType: string) {
  return isTransferLike({
    amount: row.amount,
    accountType,
    description: `${row.descriptionRaw} ${row.merchantNormalized}`,
    primary: typeof row.upstreamPayload?.primary === "string" ? row.upstreamPayload.primary : null,
  });
}
export async function autoEntryInput(db: AppDb, ownerId: string, row: ImportRow) {
  invariant(row.accountId && row.transactionDate, "自动入账缺少账户或日期");
  const account = await requireAccount(db, ownerId, row.accountId);
  const family = detectBenefit({
    amount: row.amount,
    accountType: account.type,
    description: `${row.descriptionRaw} ${row.merchantNormalized}`,
    primary: typeof row.upstreamPayload?.primary === "string" ? row.upstreamPayload.primary : null,
  });
  if (family)
    return {
      ...(await benefitInput(db, ownerId, {
        accountId: account.id,
        amount: row.amount,
        currency: row.currency,
        eventDate: row.transactionDate,
        postedDate: row.postedDate,
        merchant: row.merchantNormalized,
        description: row.descriptionRaw,
        family,
      })),
      source: "import" as const,
    };
  if (transferLikeRow(row, account.type)) return fallbackInput(db, ownerId, row);
  const suggestion = classifyRow(row, account.type);
  const positive = money(row.amount).gt(0);
  const ignoreCategorySuggestion =
    (account.type === "liability_credit_card" && positive) ||
    isCashDeposit({
      ...row,
      accountType: account.type,
      description: `${row.descriptionRaw} ${row.merchantNormalized}`,
    }) ||
    isCashAdvanceSpend({
      ...row,
      accountType: account.type,
      description: `${row.descriptionRaw} ${row.merchantNormalized}`,
    }) ||
    isZelle(`${row.descriptionRaw} ${row.merchantNormalized}`);
  const categoryId = await categoryFor(
    db,
    ownerId,
    row,
    suggestion.type === "income" || (suggestion.type === "interest" && positive) ? "income" : "expense",
    suggestion.category,
    !ignoreCategorySuggestion,
  );
  const input = await buildPostings(db, ownerId, suggestion.type, {
    amount: money(row.amount).abs().toFixed(4),
    fromAccountId: positive ? null : account.id,
    toAccountId: positive ? account.id : null,
    categoryId,
    eventDate: row.transactionDate,
    postedDate: row.postedDate,
    merchant: row.merchantNormalized,
    description: row.descriptionRaw,
    status: "confirmed",
    interestDirection: positive ? "income" : "expense",
  });
  return { ...input, source: "import" as const };
}
async function providerEntry(db: AppDb, ownerId: string, row: ImportRow) {
  if (!row.providerTransactionId || !row.accountId) return null;
  const [entry] = await db
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.ownerId, ownerId),
        eq(journalEntries.providerAccountId, row.accountId),
        eq(journalEntries.providerTransactionId, row.providerTransactionId),
      ),
    )
    .orderBy(desc(journalEntries.createdAt))
    .limit(1);
  return entry ?? null;
}
export async function nonPlaidDuplicates(db: AppDb, ownerId: string, row: ImportRow) {
  const entries = await db
    .select({ entry: journalEntries, amount: postings.amount })
    .from(journalEntries)
    .innerJoin(postings, and(eq(postings.journalEntryId, journalEntries.id), eq(postings.ownerId, ownerId)))
    .where(
      and(
        eq(journalEntries.ownerId, ownerId),
        eq(journalEntries.status, "confirmed"),
        eq(postings.accountId, row.accountId!),
        eq(postings.currency, row.currency),
      ),
    )
    .orderBy(journalEntries.id);
  const plaid = await db
    .select({ id: importRows.journalEntryId })
    .from(importRows)
    .where(and(eq(importRows.ownerId, ownerId), eq(importRows.source, "plaid")));
  const totals = new Map<string, string>();
  for (const { entry, amount } of entries)
    totals.set(
      entry.id,
      money(totals.get(entry.id) ?? "0")
        .plus(money(amount))
        .toFixed(4),
    );
  return [
    ...new Set(
      entries
        .filter(
          ({ entry }) =>
            !plaid.some((p) => p.id === entry.id) &&
            money(totals.get(entry.id)!).eq(money(row.amount)) &&
            Math.abs(
              daysBetween(row.postedDate ?? row.transactionDate!, entry.postedDate ?? entry.eventDate),
            ) <= 2 &&
            similarDescription(row.merchantNormalized, entry.merchant || entry.description || ""),
        )
        .map(({ entry }) => entry.id),
    ),
  ];
}
export async function postAutoRow(
  db: AppDb,
  ownerId: string,
  row: ImportRow,
  options: {
    distinct?: boolean;
    replacesId?: string;
    ownerEdited?: boolean;
    forceClearing?: boolean;
    replacementReason?: string;
  } = {},
) {
  invariant(row.accountId && row.transactionDate, "自动入账缺少账户或日期");
  if (money(row.amount).isZero()) {
    await updateAutoRow(db, ownerId, row.id, {
      decision: "exclude",
      softNotes: ["零金额，无需入账"],
      autoPostState: "resolved",
    });
    return null;
  }
  if (!options.replacesId && !options.distinct) {
    const existing = await providerEntry(db, ownerId, row);
    if (existing) {
      await updateAutoRow(db, ownerId, row.id, {
        linkedEntryId: existing.id,
        journalEntryId: null,
        decision: "link_existing",
        autoPostState: "resolved",
        duplicateResolution: "duplicate",
        reviewedAt: new Date(),
      });
      return existing;
    }
    // Duplicate evidence also guards transfer legs; classification never turns them into spending.
    const duplicates = await nonPlaidDuplicates(db, ownerId, row);
    if (duplicates.length) {
      await updateAutoRow(db, ownerId, row.id, {
        linkedEntryId: duplicates.length === 1 ? duplicates[0] : null,
        journalEntryId: null,
        duplicateCandidateEntryIds: duplicates,
        autoPostState: "duplicate",
        decision: "pending",
      });
      await auditLedger(db, ownerId, "import_row", row.id, "bank.suspected_duplicate", {
        entryIds: duplicates,
      });
      return null;
    }
  }
  const input = options.forceClearing
    ? await clearingInput(db, ownerId, row)
    : await autoEntryInput(db, ownerId, row);
  const entry = options.replacesId
    ? await replaceEntry(
        db,
        ownerId,
        options.replacesId,
        input,
        options.replacementReason ?? "Plaid 上游修改",
      )
    : await createEntry(db, ownerId, input);
  if (row.providerTransactionId)
    await db
      .update(journalEntries)
      .set({ providerAccountId: row.accountId, providerTransactionId: row.providerTransactionId })
      .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, entry.id)));
  if (options.replacesId)
    await db
      .update(importRows)
      .set({ linkedEntryId: entry.id })
      .where(and(eq(importRows.ownerId, ownerId), eq(importRows.linkedEntryId, options.replacesId)));
  await stampAutoEntry(db, ownerId, entry.id, options.ownerEdited);
  await updateAutoRow(db, ownerId, row.id, {
    journalEntryId: entry.id,
    linkedEntryId: null,
    decision: "approve",
    autoPostState: "posted",
    upstreamState: "none",
    reviewedAt: new Date(),
    duplicateResolution: "distinct",
    duplicateCandidateEntryIds: [],
    duplicateCandidateRowIds: [],
    suggestedEntryType: input.entryType,
    suggestedCategoryId: input.postings.find((line) => line.categoryId)?.categoryId ?? null,
  });
  await auditLedger(db, ownerId, "journal_entry", entry.id, "bank.auto_posted", { rowId: row.id });
  return entry;
}
export async function applyAutoUpstream(
  db: AppDb,
  ownerId: string,
  row: ImportRow,
  importFromDate: string,
  force = false,
) {
  const entryId = row.journalEntryId;
  if (!entryId || row.autoPostState === "none" || row.upstreamState === "none") return;
  await db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, entryId)))
    .for("update");
  const entry = await getEntry(db, ownerId, entryId);
  if ((!force && !untouched(entry)) || entry.status !== "confirmed") {
    await updateAutoRow(db, ownerId, row.id, { autoPostState: "upstream" });
    return;
  }
  let replacement: ImportRow | null = null;
  if (row.upstreamState === "modified") {
    const parsed = payloadSchema.safeParse(row.upstreamPayload);
    if (!parsed.success) {
      await updateAutoRow(db, ownerId, row.id, { autoPostState: "upstream" });
      return;
    }
    const p = parsed.data;
    const [mapping] = await db
      .select()
      .from(bankConnectionAccounts)
      .where(
        and(
          eq(bankConnectionAccounts.ownerId, ownerId),
          eq(bankConnectionAccounts.connectionId, row.bankConnectionId!),
          eq(bankConnectionAccounts.plaidAccountId, p.accountId),
        ),
      );
    if (
      !p.pending &&
      !isCoreSweep(`${p.name ?? ""} ${p.description} ${p.merchant}`) &&
      p.postedDate >= effectiveFromDate({ importFromDate }, mapping) &&
      p.currency &&
      mapping?.isEnabled &&
      mapping.accountId &&
      mapping.currency === p.currency &&
      ["depository", "credit"].includes(mapping.type) &&
      !money(p.amount).isZero()
    ) {
      replacement = {
        ...row,
        accountId: mapping.accountId,
        amount: p.amount,
        amountRaw: p.amount,
        transactionDate: p.transactionDate,
        postedDate: p.postedDate,
        currency: p.currency,
        descriptionRaw: p.description,
        sourceRowText: p.description,
        merchantNormalized: normalizeMerchant(p.merchant),
        suggestedCategoryId: null,
      };
    }
  }
  await unlinkLeg(db, ownerId, entryId, false, true);
  if (replacement) {
    await updateAutoRow(db, ownerId, row.id, {
      amount: replacement.amount,
      amountRaw: replacement.amount,
      accountId: replacement.accountId,
      transactionDate: replacement.transactionDate,
      postedDate: replacement.postedDate,
      currency: replacement.currency,
      descriptionRaw: replacement.descriptionRaw,
      sourceRowText: replacement.sourceRowText,
      merchantNormalized: replacement.merchantNormalized,
      suggestedCategoryId: null,
    });
    await postAutoRow(db, ownerId, replacement, { replacesId: entryId, ownerEdited: force });
  } else {
    await voidEntry(db, ownerId, entryId, "Plaid 上游删除或不再符合导入范围");
    await updateAutoRow(db, ownerId, row.id, {
      autoPostState: "resolved",
      decision: "exclude",
      upstreamState: "none",
      reviewedAt: new Date(),
    });
  }
  await auditLedger(db, ownerId, "import_row", row.id, "bank.upstream_applied", { originalEntryId: entryId });
}
async function ignoreCoreSweeps(db: AppDb, ownerId: string, rows: ImportRow[]) {
  const touched = new Set<string>();
  for (const row of rows) {
    if (
      row.ownerId !== ownerId ||
      row.source !== "plaid" ||
      !isCoreSweep(`${row.descriptionRaw} ${row.merchantNormalized}`)
    )
      continue;
    const softNotes = [...new Set([...row.softNotes, CORE_SWEEP_NOTE])];
    if (!row.journalEntryId && !row.linkedEntryId && row.decision === "pending") {
      await updateAutoRow(db, ownerId, row.id, {
        decision: "exclude",
        autoPostState: "resolved",
        duplicateCandidateRowIds: [],
        duplicateCandidateEntryIds: [],
        softNotes,
        reviewedAt: new Date(),
      });
      touched.add(row.statementId);
    } else if (row.journalEntryId && row.autoPostState === "posted" && row.upstreamState === "none") {
      await db
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, row.journalEntryId)))
        .for("update");
      const entry = await getEntry(db, ownerId, row.journalEntryId);
      if (!untouched(entry) || entry.status !== "confirmed" || entry.transferMatchId) continue;
      await voidEntry(db, ownerId, entry.id, "Fidelity SPAXX 核心仓位申赎不计入流水");
      await updateAutoRow(db, ownerId, row.id, {
        autoPostState: "resolved",
        decision: "exclude",
        softNotes,
        reviewedAt: new Date(),
      });
      await auditLedger(db, ownerId, "import_row", row.id, "bank.core_sweep_ignored", {
        rowId: row.id,
        entryId: entry.id,
      });
      touched.add(row.statementId);
    }
  }
  return touched;
}
async function reclassifyClearing(db: AppDb, ownerId: string, row: ImportRow) {
  if (!row.journalEntryId || !row.accountId || row.autoPostState !== "posted" || row.upstreamState !== "none")
    return;
  const account = await requireAccount(db, ownerId, row.accountId);
  if (account.type === "liability_loan") return;
  await db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, row.journalEntryId)))
    .for("update");
  const entry = await getEntry(db, ownerId, row.journalEntryId);
  if (!untouched(entry) || entry.transferMatchId || entry.postings.length !== 2) return;
  const own = entry.postings.find((line) => line.accountId === account.id);
  const other = entry.postings.find((line) => line.accountId !== account.id);
  if (
    !own ||
    !other ||
    !money(own.amount).eq(money(row.amount)) ||
    own.currency !== row.currency ||
    (await requireAccount(db, ownerId, other.accountId)).type !== "transfer_clearing"
  )
    return;
  const replacement = await postAutoRow(db, ownerId, row, {
    replacesId: entry.id,
    replacementReason: "未匹配转账改为收支",
  });
  invariant(replacement, "重新分类未生成流水");
  await updateAutoRow(db, ownerId, row.id, { direction: classifyRow(row, account.type).direction });
  await auditLedger(
    db,
    ownerId,
    "journal_entry",
    replacement.id,
    replacement.entryType === "refund" ? "auto_reclassified_refund" : "auto_reclassified",
    { originalEntryId: entry.id, rowId: row.id },
  );
}
export async function autoPostOwnerRows(
  db: AppDb,
  ownerId: string,
  environment: "sandbox" | "production",
  now = new Date(),
) {
  await ensureDefaultCategories(db, ownerId);
  const connections = await db
    .select()
    .from(bankConnections)
    .where(
      and(
        eq(bankConnections.ownerId, ownerId),
        eq(bankConnections.environment, environment),
        eq(bankConnections.autoPost, true),
        ne(bankConnections.status, "revoked"),
      ),
    );
  if (!connections.length) return;
  const loadRows = () =>
    db
      .select()
      .from(importRows)
      .where(
        and(
          eq(importRows.ownerId, ownerId),
          eq(importRows.source, "plaid"),
          inArray(
            importRows.bankConnectionId,
            connections.map((row) => row.id),
          ),
        ),
      )
      .orderBy(importRows.createdAt, importRows.statementId, importRows.rowIndex, importRows.id);
  const initialRows = await loadRows();
  const initialEntryIds = new Map(initialRows.map((row) => [row.id, row.journalEntryId]));
  for (const row of initialRows) {
    if (
      row.journalEntryId &&
      row.autoPostState !== "none" &&
      row.autoPostState !== "duplicate" &&
      row.upstreamState !== "none"
    ) {
      const connection = connections.find((item) => item.id === row.bankConnectionId)!;
      await applyAutoUpstream(db, ownerId, row, connection.importFromDate);
    }
  }
  const touched = await ignoreCoreSweeps(db, ownerId, await loadRows());
  const mappings = await db
    .select()
    .from(bankConnectionAccounts)
    .where(and(eq(bankConnectionAccounts.ownerId, ownerId), eq(bankConnectionAccounts.isEnabled, true)));
  const fromDate = (row: ImportRow, connection: { importFromDate: string }) =>
    effectiveFromDate(
      connection,
      mappings.find((item) => item.connectionId === row.bankConnectionId && item.accountId === row.accountId),
    );
  const mapped = (row: ImportRow) =>
    mappings.some(
      (item) =>
        item.connectionId === row.bankConnectionId &&
        item.accountId === row.accountId &&
        ["credit", "depository"].includes(item.type) &&
        item.currency === row.currency,
    );
  const matchRows = (await loadRows()).filter((row) => {
    const connection = connections.find((item) => item.id === row.bankConnectionId)!;
    return (
      mapped(row) &&
      row.transactionDate &&
      (row.postedDate ?? row.transactionDate) >= fromDate(row, connection)
    );
  });
  const canPost = async (row: ImportRow) =>
    matchRows.some((item) => item.id === row.id) &&
    !(await providerEntry(db, ownerId, row)) &&
    !(await nonPlaidDuplicates(db, ownerId, row)).length;
  await restoreTransferChoices(db, ownerId, environment, { rows: await loadRows(), now, canPost });
  const currentRows = await loadRows();
  await matchUniqueLegs(db, ownerId, environment, {
    rows: currentRows,
    changedEntryIds: new Set(
      currentRows.flatMap((row) =>
        row.journalEntryId && row.journalEntryId !== initialEntryIds.get(row.id) ? [row.journalEntryId] : [],
      ),
    ),
    now,
    canPost,
  });
  const ordered = await loadRows();
  for (const row of ordered) {
    const connection = connections.find((item) => item.id === row.bankConnectionId)!;
    if (row.journalEntryId || row.linkedEntryId) {
      touched.add(row.statementId);
      continue;
    }
    if (
      row.autoPostState !== "none" ||
      row.decision !== "pending" ||
      !row.accountId ||
      !row.transactionDate ||
      row.upstreamState === "removed" ||
      (row.postedDate ?? row.transactionDate) < fromDate(row, connection)
    )
      continue;
    if (!mapped(row)) continue;
    await postAutoRow(db, ownerId, row);
    touched.add(row.statementId);
  }
  await rescanBenefits(db, ownerId, connections, await loadRows(), now);
  for (const row of await loadRows()) await reclassifyClearing(db, ownerId, row);
  for (const statementId of touched) await updateApprovalStatus(db, ownerId, statementId, 0, new Date());
}
