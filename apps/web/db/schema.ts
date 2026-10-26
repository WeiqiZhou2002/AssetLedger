import { sql } from "drizzle-orm";
import {
  char,
  check,
  date,
  foreignKey,
  integer,
  numeric,
  pgEnum,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { accountTypes, entryTypes } from "@/lib/ledger/constants";
import { bigint, boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
const timestamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  baseCurrency: text("base_currency").notNull().default("USD"),
  timezone: text("timezone").notNull().default("America/Los_Angeles"),
  totpSecretEnc: text("totp_secret_enc"),
  totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
  totpPendingSecretEnc: text("totp_pending_secret_enc"),
  totpPendingExpiresAt: timestamp("totp_pending_expires_at", { withTimezone: true }),
  totpLastUsedStep: bigint("totp_last_used_step", { mode: "bigint" }),
  ...timestamps(),
});
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipHash: text("ip_hash").notNull(),
    userAgent: text("user_agent").notNull(),
    ...timestamps(),
  },
  (table) => [index("sessions_user_idx").on(table.userId), index("sessions_expiry_idx").on(table.expiresAt)],
);
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    keyHash: text("key_hash").notNull(),
    succeeded: boolean("succeeded").notNull(),
    ...timestamps(),
  },
  (table) => [index("login_attempts_key_time_idx").on(table.keyHash, table.createdAt)],
);
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    action: text("action").notNull(),
    changes: jsonb("changes").$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
  },
  (table) => [index("audit_logs_owner_idx").on(table.ownerId, table.createdAt)],
);

export const accountType = pgEnum("account_type", accountTypes);
export const entryType = pgEnum("entry_type", entryTypes);
export const institutionKind = pgEnum("institution_kind", [
  "bank",
  "card_issuer",
  "brokerage",
  "wallet",
  "other",
]);
export const categoryKind = pgEnum("category_kind", ["expense", "income"]);
export const entryStatus = pgEnum("entry_status", ["draft", "confirmed", "voided"]);
export const entrySource = pgEnum("entry_source", ["manual", "import", "legacy", "system"]);
export const prepaymentMode = pgEnum("prepayment_mode", ["asset", "expense"]);
export const dateBasis = pgEnum("date_basis", ["posted", "event"]);
const owned = () => ({
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id),
  ...timestamps(),
});
export const institutions = pgTable(
  "institutions",
  {
    ...owned(),
    name: text("name").notNull(),
    kind: institutionKind("kind").notNull(),
    parserKey: text("parser_key"),
    plaidInstitutionId: text("plaid_institution_id"),
    notes: text("notes"),
  },
  (t) => [
    unique("institutions_owner_id_unique").on(t.ownerId, t.id),
    unique("institutions_owner_name_unique").on(t.ownerId, t.name),
    unique("institutions_owner_plaid_unique").on(t.ownerId, t.plaidInstitutionId),
  ],
);
export const accountGroups = pgTable(
  "account_groups",
  {
    ...owned(),
    name: text("name").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    cashLikeInclusion: boolean("cash_like_inclusion").notNull().default(true),
    financialInclusion: boolean("financial_inclusion").notNull().default(true),
    isSecurity: boolean("is_security").notNull().default(false),
    needsMapping: boolean("needs_mapping").notNull().default(false),
    notes: text("notes"),
  },
  (t) => [
    unique("account_groups_owner_id_unique").on(t.ownerId, t.id),
    unique("account_groups_owner_name_unique").on(t.ownerId, t.name),
    check("account_groups_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check("account_groups_security_check", sql`NOT ${t.isSecurity} OR NOT ${t.cashLikeInclusion}`),
  ],
);
export const accounts = pgTable(
  "accounts",
  {
    ...owned(),
    institutionId: uuid("institution_id"),
    accountGroupId: uuid("account_group_id"),
    name: text("name").notNull(),
    type: accountType("type").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    last4: text("last4"),
    isActive: boolean("is_active").notNull().default(true),
    isSystem: boolean("is_system").notNull().default(false),
    cashLikeInclusion: boolean("cash_like_inclusion").notNull().default(false),
    financialInclusion: boolean("financial_inclusion").notNull().default(true),
    openedOn: date("opened_on"),
    closedOn: date("closed_on"),
    statementDay: integer("statement_day"),
    paymentDueDay: integer("payment_due_day"),
    balanceReminderDays: integer("balance_reminder_days").default(7),
    sortOrder: integer("sort_order").notNull().default(0),
    notes: text("notes"),
  },
  (t) => [
    unique("accounts_owner_id_unique").on(t.ownerId, t.id),
    unique("accounts_owner_name_unique").on(t.ownerId, t.name),
    uniqueIndex("accounts_system_unique")
      .on(t.ownerId, t.type, t.currency)
      .where(sql`${t.isSystem} = true`),
    foreignKey({
      columns: [t.ownerId, t.institutionId],
      foreignColumns: [institutions.ownerId, institutions.id],
    }),
    foreignKey({
      columns: [t.ownerId, t.accountGroupId],
      foreignColumns: [accountGroups.ownerId, accountGroups.id],
    }),
    check(
      "accounts_balance_reminder_days_check",
      sql`${t.balanceReminderDays} IS NULL OR ${t.balanceReminderDays} IN (1, 3, 7, 14, 30)`,
    ),
    check("accounts_last4_check", sql`${t.last4} IS NULL OR ${t.last4} ~ '^[0-9]{4,5}$'`),
    check("accounts_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      "accounts_days_check",
      sql`(${t.statementDay} IS NULL OR ${t.statementDay} BETWEEN 1 AND 31) AND (${t.paymentDueDay} IS NULL OR ${t.paymentDueDay} BETWEEN 1 AND 31)`,
    ),
    check(
      "accounts_dates_check",
      sql`${t.openedOn} IS NULL OR ${t.closedOn} IS NULL OR ${t.closedOn} >= ${t.openedOn}`,
    ),
    check(
      "accounts_system_check",
      sql`${t.isSystem} = (${t.type}::text IN ('income','expense','equity_opening','fx_clearing','transfer_clearing','reconciliation_adjustment'))`,
    ),
    check(
      "accounts_inclusion_check",
      sql`NOT ${t.cashLikeInclusion} OR ${t.type} IN ('asset_cash','asset_brokerage_cash','liability_credit_card','liability_loan')`,
    ),
  ],
);
export const accountCardSecrets = pgTable(
  "account_card_secrets",
  {
    ...owned(),
    accountId: uuid("account_id").notNull(),
    payloadEnc: text("payload_enc").notNull(),
    numberLast4: text("number_last4").notNull(),
    network: text("network").$type<"visa" | "mastercard" | "amex" | "discover" | "other">().notNull(),
    hasExpiry: boolean("has_expiry").notNull(),
    hasCvv: boolean("has_cvv").notNull(),
    hasCid: boolean("has_cid").notNull(),
  },
  (t) => [
    unique("account_card_secrets_account_unique").on(t.ownerId, t.accountId),
    foreignKey({
      columns: [t.ownerId, t.accountId],
      foreignColumns: [accounts.ownerId, accounts.id],
    }).onDelete("cascade"),
    check("account_card_secrets_last4_check", sql`${t.numberLast4} ~ '^[0-9]{4}$'`),
    check(
      "account_card_secrets_network_check",
      sql`${t.network} IN ('visa','mastercard','amex','discover','other')`,
    ),
  ],
);
export const categories = pgTable(
  "categories",
  {
    ...owned(),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    kind: categoryKind("kind").notNull(),
    icon: text("icon"),
    isSystem: boolean("is_system").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    isArchived: boolean("is_archived").notNull().default(false),
  },
  (t) => [
    unique("categories_owner_id_unique").on(t.ownerId, t.id),
    unique("categories_owner_kind_name_unique").on(t.ownerId, t.kind, t.name),
    foreignKey({ columns: [t.ownerId, t.parentId], foreignColumns: [t.ownerId, t.id] }),
  ],
);
export const purchaseGroups = pgTable(
  "purchase_groups",
  {
    ...owned(),
    title: text("title").notNull(),
    confirmedTotal: numeric("confirmed_total", { precision: 20, scale: 4 }),
    currency: char("currency", { length: 3 }).notNull(),
    categoryId: uuid("category_id"),
    notes: text("notes"),
  },
  (t) => [
    unique("purchase_groups_owner_id_unique").on(t.ownerId, t.id),
    foreignKey({ columns: [t.ownerId, t.categoryId], foreignColumns: [categories.ownerId, categories.id] }),
    check("purchase_groups_total_check", sql`${t.confirmedTotal} IS NULL OR ${t.confirmedTotal} >= 0`),
    check("purchase_groups_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);
export const journalEntries = pgTable(
  "journal_entries",
  {
    ...owned(),
    entryType: entryType("entry_type").notNull(),
    isSummary: boolean("is_summary").notNull().default(false),
    status: entryStatus("status").notNull().default("draft"),
    eventDate: date("event_date").notNull(),
    postedDate: date("posted_date"),
    merchant: text("merchant"),
    description: text("description"),
    notes: text("notes"),
    source: entrySource("source").notNull().default("manual"),
    purchaseGroupId: uuid("purchase_group_id"),
    replacesEntryId: uuid("replaces_entry_id"),
    refundOfEntryId: uuid("refund_of_entry_id"),
    benefitCredit: boolean("benefit_credit").notNull().default(false),
    benefitFamily: text("benefit_family"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    externalReference: text("external_reference"),
    providerTransactionId: text("provider_transaction_id"),
    providerAccountId: uuid("provider_account_id"),
    transferMatchId: uuid("transfer_match_id"),
    autoPosted: boolean("auto_posted").notNull().default(false),
    autoPostFingerprint: text("auto_post_fingerprint"),
    autoPostOwnerEdited: boolean("auto_post_owner_edited").notNull().default(false),
  },
  (t) => [
    unique("journal_entries_owner_id_unique").on(t.ownerId, t.id),
    uniqueIndex("journal_entries_provider_unique")
      .on(t.ownerId, t.providerAccountId, t.providerTransactionId)
      .where(
        sql`${t.providerAccountId} IS NOT NULL AND ${t.providerTransactionId} IS NOT NULL AND ${t.status} <> 'voided'`,
      ),
    foreignKey({
      columns: [t.ownerId, t.providerAccountId],
      foreignColumns: [accounts.ownerId, accounts.id],
    }),
    index("journal_entries_owner_date_idx").on(t.ownerId, t.eventDate),
    index("journal_entries_owner_posted_idx").on(t.ownerId, t.postedDate),
    index("journal_entries_group_idx").on(t.ownerId, t.purchaseGroupId),
    index("journal_entries_transfer_match_idx").on(t.ownerId, t.transferMatchId),
    foreignKey({
      columns: [t.ownerId, t.purchaseGroupId],
      foreignColumns: [purchaseGroups.ownerId, purchaseGroups.id],
    }),
    foreignKey({ columns: [t.ownerId, t.replacesEntryId], foreignColumns: [t.ownerId, t.id] }),
    foreignKey({ columns: [t.ownerId, t.refundOfEntryId], foreignColumns: [t.ownerId, t.id] }),
  ],
);
export const transferPairRejections = pgTable(
  "transfer_pair_rejections",
  {
    ...owned(),
    leftKey: text("left_key").notNull(),
    rightKey: text("right_key").notNull(),
  },
  (t) => [unique("transfer_pair_rejections_owner_pair_unique").on(t.ownerId, t.leftKey, t.rightKey)],
);
export const transferPairConfirmations = pgTable(
  "transfer_pair_confirmations",
  { ...owned(), leftKey: text("left_key").notNull(), rightKey: text("right_key").notNull() },
  (t) => [unique("transfer_pair_confirmations_owner_pair_unique").on(t.ownerId, t.leftKey, t.rightKey)],
);
export const transferAccountAssignments = pgTable(
  "transfer_account_assignments",
  { ...owned(), legKey: text("leg_key").notNull(), accountId: uuid("account_id").notNull() },
  (t) => [
    unique("transfer_account_assignments_owner_leg_unique").on(t.ownerId, t.legKey),
    foreignKey({ columns: [t.ownerId, t.accountId], foreignColumns: [accounts.ownerId, accounts.id] }),
  ],
);
export const postings = pgTable(
  "postings",
  {
    ...owned(),
    journalEntryId: uuid("journal_entry_id").notNull(),
    accountId: uuid("account_id").notNull(),
    categoryId: uuid("category_id"),
    amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    memo: text("memo"),
  },
  (t) => [
    index("postings_account_idx").on(t.ownerId, t.accountId),
    index("postings_entry_idx").on(t.ownerId, t.journalEntryId),
    foreignKey({
      columns: [t.ownerId, t.journalEntryId],
      foreignColumns: [journalEntries.ownerId, journalEntries.id],
    }),
    foreignKey({ columns: [t.ownerId, t.accountId], foreignColumns: [accounts.ownerId, accounts.id] }),
    foreignKey({ columns: [t.ownerId, t.categoryId], foreignColumns: [categories.ownerId, categories.id] }),
    check("postings_nonzero_check", sql`${t.amount} <> 0`),
    check("postings_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);
export const userSettings = pgTable(
  "user_settings",
  {
    ...owned(),
    prepaymentMode: prepaymentMode("prepayment_mode").notNull().default("asset"),
    spendingDateBasis: dateBasis("spending_date_basis").notNull().default("posted"),
  },
  (t) => [unique("user_settings_owner_unique").on(t.ownerId)],
);

export const bankConnections = pgTable(
  "bank_connections",
  {
    ...owned(),
    provider: text("provider", { enum: ["plaid"] })
      .notNull()
      .default("plaid"),
    environment: text("environment", { enum: ["sandbox", "production"] }).notNull(),
    plaidItemId: text("plaid_item_id").notNull(),
    institutionId: text("institution_id"),
    institutionName: text("institution_name").notNull(),
    products: text("products")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    accessTokenEnc: text("access_token_enc").notNull(),
    status: text("status", { enum: ["active", "login_required", "consent_expiring", "revoked", "error"] })
      .notNull()
      .default("active"),
    errorCode: text("error_code"),
    consentExpiresAt: timestamp("consent_expires_at", { withTimezone: true }),
    transactionsCursor: text("transactions_cursor"),
    autoPost: boolean("auto_post").notNull().default(true),
    syncGeneration: integer("sync_generation").notNull().default(0),
    matchingVersion: integer("matching_version").notNull().default(0),
    benefitVersion: integer("benefit_version").notNull().default(0),
    matchingGeneration: integer("matching_generation").notNull().default(-1),
    backfillPlan: jsonb("backfill_plan").$type<import("@/lib/bank-sync/backfill-types").BackfillState>(),
    importFromDate: date("import_from_date").notNull(),
    daysRequested: integer("days_requested").notNull().default(90),
    mappingConfirmedAt: timestamp("mapping_confirmed_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastRequestedAt: timestamp("last_requested_at", { withTimezone: true }),
  },
  (t) => [
    unique("bank_connections_owner_id_unique").on(t.ownerId, t.id),
    unique("bank_connections_item_unique").on(t.ownerId, t.environment, t.plaidItemId),
  ],
);
export const bankConnectionAccounts = pgTable(
  "bank_connection_accounts",
  {
    ...owned(),
    connectionId: uuid("connection_id").notNull(),
    plaidAccountId: text("plaid_account_id").notNull(),
    name: text("name").notNull(),
    officialName: text("official_name"),
    mask: text("mask"),
    type: text("type").notNull(),
    subtype: text("subtype"),
    currency: char("currency", { length: 3 }),
    accountId: uuid("account_id"),
    securityAccountId: uuid("security_account_id"),
    importFromDate: date("import_from_date"),
    accountCreatedHere: boolean("account_created_here").notNull().default(false),
    isEnabled: boolean("is_enabled").notNull().default(false),
    lastBalanceCurrent: numeric("last_balance_current", { precision: 20, scale: 4 }),
    lastBalanceAvailable: numeric("last_balance_available", { precision: 20, scale: 4 }),
    lastBalanceLimit: numeric("last_balance_limit", { precision: 20, scale: 4 }),
    lastBalanceAt: timestamp("last_balance_at", { withTimezone: true }),
  },
  (t) => [
    unique("bank_accounts_provider_unique").on(t.connectionId, t.plaidAccountId),
    unique("bank_accounts_ledger_unique").on(t.ownerId, t.accountId),
    unique("bank_accounts_security_unique").on(t.ownerId, t.securityAccountId),
    foreignKey({
      columns: [t.ownerId, t.connectionId],
      foreignColumns: [bankConnections.ownerId, bankConnections.id],
    }),
    foreignKey({ columns: [t.ownerId, t.accountId], foreignColumns: [accounts.ownerId, accounts.id] }),
    foreignKey({
      columns: [t.ownerId, t.securityAccountId],
      foreignColumns: [accounts.ownerId, accounts.id],
    }),
  ],
);

export const bankSyncRuns = pgTable(
  "bank_sync_runs",
  {
    ...owned(),
    connectionId: uuid("connection_id").notNull(),
    jobId: uuid("job_id"),
    kind: text("kind", { enum: ["sync", "backfill", "reset"] }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: text("status", {
      enum: ["queued", "running", "not_ready", "succeeded", "failed", "superseded"],
    }).notNull(),
    effectiveFromDate: date("effective_from_date").notNull(),
    updateStatus: text("update_status"),
    counts: jsonb("counts")
      .$type<
        import("@/lib/bank-sync/run-counts").SyncCounts &
          Partial<import("@/lib/bank-sync/reset-types").ResetCounts>
      >()
      .notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.ownerId, t.connectionId],
      foreignColumns: [bankConnections.ownerId, bankConnections.id],
    }),
    index("bank_sync_runs_latest_idx").on(t.ownerId, t.connectionId, t.startedAt),
  ],
);

export const merchantCategoryMemory = pgTable(
  "merchant_category_memory",
  {
    ...owned(),
    merchant: text("merchant").notNull(),
    accountType: accountType("account_type").notNull(),
    categoryId: uuid("category_id").notNull(),
    source: text("source", { enum: ["owner_edited", "auto"] }).notNull(),
    lastUsed: timestamp("last_used", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("merchant_memory_key_unique").on(t.ownerId, t.merchant, t.accountType),
    foreignKey({ columns: [t.ownerId, t.categoryId], foreignColumns: [categories.ownerId, categories.id] }),
  ],
);
export const bankResetExports = pgTable("bank_reset_exports", {
  ...owned(),
  storagePath: text("storage_path"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  counts: jsonb("counts").$type<import("@/lib/bank-sync/reset-types").ResetCounts>().notNull(),
});

export const snapshotSource = pgEnum("snapshot_source", ["manual", "legacy_xlsx", "statement", "plaid"]);
export const snapshotStatus = pgEnum("snapshot_status", ["draft", "published"]);
export const fxRates = pgTable(
  "fx_rates",
  {
    ...owned(),
    baseCurrency: char("base_currency", { length: 3 }).notNull(),
    quoteCurrency: char("quote_currency", { length: 3 }).notNull(),
    rate: numeric("rate", { precision: 20, scale: 10 }).notNull(),
    observedOn: date("observed_on").notNull(),
    source: text("source").notNull(),
    isManual: boolean("is_manual").notNull().default(true),
  },
  (t) => [
    unique("fx_rates_owner_id_unique").on(t.ownerId, t.id),
    index("fx_rates_lookup_idx").on(t.ownerId, t.baseCurrency, t.quoteCurrency, t.observedOn),
    check("fx_rates_positive_check", sql`${t.rate} > 0`),
    check(
      "fx_rates_currency_check",
      sql`${t.baseCurrency} ~ '^[A-Z]{3}$' AND ${t.quoteCurrency} ~ '^[A-Z]{3}$' AND ${t.baseCurrency} <> ${t.quoteCurrency}`,
    ),
  ],
);
export const balanceSnapshots = pgTable(
  "balance_snapshots",
  {
    ...owned(),
    snapshotDate: date("snapshot_date").notNull(),
    label: text("label").notNull(),
    source: snapshotSource("source").notNull().default("manual"),
    status: snapshotStatus("status").notNull().default("draft"),
    baseCurrency: char("base_currency", { length: 3 }).notNull(),
    isComplete: boolean("is_complete").notNull().default(false),
    revision: integer("revision").notNull().default(1),
    notes: text("notes"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    // Only Plaid is outside these pre-existing source values. Avoid using the newly
    // added enum literal in DDL within the migration transaction.
    uniqueIndex("balance_snapshots_plaid_date_unique")
      .on(t.ownerId, t.source, t.snapshotDate)
      .where(sql`${t.source} NOT IN ('manual', 'legacy_xlsx', 'statement')`),
    unique("balance_snapshots_owner_id_unique").on(t.ownerId, t.id),
    index("balance_snapshots_owner_date_idx").on(t.ownerId, t.snapshotDate),
  ],
);
export const snapshotItems = pgTable(
  "snapshot_items",
  {
    ...owned(),
    snapshotId: uuid("snapshot_id").notNull(),
    accountId: uuid("account_id"),
    accountGroupId: uuid("account_group_id"),
    balanceNative: numeric("balance_native", { precision: 20, scale: 4 }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    sourceRef: text("source_ref"),
    version: integer("version").notNull().default(1),
    isCurrent: boolean("is_current").notNull().default(true),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("snapshot_items_current_account_unique")
      .on(t.ownerId, t.snapshotId, t.accountId)
      .where(sql`${t.isCurrent}`),
    uniqueIndex("snapshot_items_current_group_unique")
      .on(t.ownerId, t.snapshotId, t.accountGroupId)
      .where(sql`${t.isCurrent}`),
    foreignKey({
      columns: [t.ownerId, t.snapshotId],
      foreignColumns: [balanceSnapshots.ownerId, balanceSnapshots.id],
    }),
    foreignKey({ columns: [t.ownerId, t.accountId], foreignColumns: [accounts.ownerId, accounts.id] }),
    foreignKey({
      columns: [t.ownerId, t.accountGroupId],
      foreignColumns: [accountGroups.ownerId, accountGroups.id],
    }),
    check(
      "snapshot_items_target_check",
      sql`(${t.accountId} IS NOT NULL)::int + (${t.accountGroupId} IS NOT NULL)::int = 1`,
    ),
    check("snapshot_items_version_check", sql`${t.version} > 0`),
    check("snapshot_items_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);
export const snapshotFx = pgTable(
  "snapshot_fx",
  {
    ...owned(),
    snapshotId: uuid("snapshot_id").notNull(),
    quoteCurrency: char("quote_currency", { length: 3 }).notNull(),
    rate: numeric("rate", { precision: 20, scale: 10 }).notNull(),
    observedOn: date("observed_on").notNull(),
    source: text("source").notNull(),
    fxRateId: uuid("fx_rate_id"),
  },
  (t) => [
    unique("snapshot_fx_currency_unique").on(t.ownerId, t.snapshotId, t.quoteCurrency),
    foreignKey({
      columns: [t.ownerId, t.snapshotId],
      foreignColumns: [balanceSnapshots.ownerId, balanceSnapshots.id],
    }),
    foreignKey({ columns: [t.ownerId, t.fxRateId], foreignColumns: [fxRates.ownerId, fxRates.id] }),
    check("snapshot_fx_rate_check", sql`${t.rate} > 0`),
  ],
);

export const statementStatus = pgEnum("statement_status", [
  "uploaded",
  "queued",
  "parsing",
  "needs_mapping",
  "needs_review",
  "approved",
  "failed",
  "discarded",
]);
export const importJobKind = pgEnum("import_job_kind", ["pdf", "csv", "ai_parse", "render", "plaid_sync"]);
export const importJobStatus = pgEnum("import_job_status", ["queued", "running", "succeeded", "failed"]);
export const importDecision = pgEnum("import_decision", ["pending", "approve", "exclude", "link_existing"]);
export const duplicateResolution = pgEnum("duplicate_resolution", ["none", "distinct", "duplicate"]);
export const statements = pgTable(
  "statements",
  {
    ...owned(),
    accountId: uuid("account_id"),
    institutionId: uuid("institution_id"),
    source: text("source", { enum: ["upload", "plaid"] })
      .notNull()
      .default("upload"),
    connectionId: uuid("connection_id"),
    syncDate: date("sync_date"),
    title: text("title"),
    fileSha256: text("file_sha256"),
    originalFilename: text("original_filename"),
    mime: text("mime"),
    sizeBytes: integer("size_bytes"),
    pageCount: integer("page_count"),
    storagePath: text("storage_path"),
    status: statementStatus("status").notNull().default("uploaded"),
    statementType: text("statement_type", { enum: ["credit_card", "bank", "unknown"] })
      .notNull()
      .default("unknown"),
    issuer: text("issuer"),
    accountLast4: text("account_last4"),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    currency: char("currency", { length: 3 }),
    summary: jsonb("summary").$type<import("@/lib/imports/types").StatementSummary>().notNull().default({}),
    parser: text("parser"),
    parserVersion: text("parser_version"),
    aiUsed: boolean("ai_used").notNull().default(false),
    diagnostics: jsonb("diagnostics")
      .$type<import("@/lib/imports/types").Diagnostic[]>()
      .notNull()
      .default([]),
    transactionLines: jsonb("transaction_lines")
      .$type<import("@/lib/imports/types").TransactionLine[]>()
      .notNull()
      .default([]),
    deleteFileAfter: timestamp("delete_file_after", { withTimezone: true }),
  },
  (t) => [
    unique("statements_owner_id_unique").on(t.ownerId, t.id),
    uniqueIndex("statements_owner_hash_unique")
      .on(t.ownerId, t.fileSha256)
      .where(sql`${t.fileSha256} IS NOT NULL`),
    unique("statements_connection_date_unique").on(t.ownerId, t.connectionId, t.syncDate),
    foreignKey({
      columns: [t.ownerId, t.connectionId],
      foreignColumns: [bankConnections.ownerId, bankConnections.id],
    }),
    check(
      "statements_source_check",
      sql`(${t.source} = 'upload' AND ${t.fileSha256} IS NOT NULL AND ${t.mime} IS NOT NULL AND ${t.originalFilename} IS NOT NULL AND ${t.sizeBytes} IS NOT NULL) OR (${t.source} = 'plaid' AND ${t.connectionId} IS NOT NULL AND ${t.syncDate} IS NOT NULL AND ${t.fileSha256} IS NULL AND ${t.storagePath} IS NULL)`,
    ),
    foreignKey({ columns: [t.ownerId, t.accountId], foreignColumns: [accounts.ownerId, accounts.id] }),
    foreignKey({
      columns: [t.ownerId, t.institutionId],
      foreignColumns: [institutions.ownerId, institutions.id],
    }),
    check("statements_last4_check", sql`${t.accountLast4} IS NULL OR ${t.accountLast4} ~ '^[0-9]{4}$'`),
    check("statements_size_check", sql`${t.sizeBytes} > 0`),
  ],
);
export const importJobs = pgTable(
  "import_jobs",
  {
    ...owned(),
    statementId: uuid("statement_id"),
    connectionId: uuid("connection_id"),
    kind: importJobKind("kind").notNull(),
    status: importJobStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    errorKind: text("error_kind"),
    progress: integer("progress").notNull().default(0),
    syncGeneration: integer("sync_generation").notNull().default(0),
    syncRunId: uuid("sync_run_id"),
    consent: jsonb("consent").$type<import("@/lib/imports/types").AiConsent>(),
  },
  (t) => [
    foreignKey({ columns: [t.ownerId, t.statementId], foreignColumns: [statements.ownerId, statements.id] }),
    foreignKey({
      columns: [t.ownerId, t.connectionId],
      foreignColumns: [bankConnections.ownerId, bankConnections.id],
    }),
    check(
      "import_jobs_target_check",
      sql`(${t.kind}::text = 'plaid_sync' AND ${t.connectionId} IS NOT NULL AND ${t.statementId} IS NULL) OR (${t.kind}::text <> 'plaid_sync' AND ${t.statementId} IS NOT NULL AND ${t.connectionId} IS NULL)`,
    ),
    uniqueIndex("import_jobs_active_connection_unique")
      .on(t.ownerId, t.connectionId)
      .where(sql`${t.status} IN ('queued', 'running')`),
    index("import_jobs_poll_idx").on(t.status, t.runAfter),
    uniqueIndex("import_jobs_active_unique")
      .on(t.ownerId, t.statementId)
      .where(sql`${t.status} IN ('queued', 'running')`),
    check("import_jobs_progress_check", sql`${t.progress} BETWEEN 0 AND 100`),
  ],
);
export const importRows = pgTable(
  "import_rows",
  {
    ...owned(),
    statementId: uuid("statement_id").notNull(),
    rowIndex: integer("row_index").notNull(),
    accountId: uuid("account_id"),
    bankConnectionId: uuid("bank_connection_id"),
    upstreamState: text("upstream_state", { enum: ["none", "modified", "removed"] })
      .notNull()
      .default("none"),
    upstreamPayload: jsonb("upstream_payload").$type<Record<string, unknown>>(),
    autoPostState: text("auto_post_state", {
      enum: ["none", "posted", "duplicate", "upstream", "resolved"],
    })
      .notNull()
      .default("none"),
    sourcePage: integer("source_page"),
    sourceRowText: text("source_row_text").notNull(),
    source: text("source", { enum: ["parser", "csv", "ai", "plaid"] })
      .notNull()
      .default("parser"),
    transactionDate: date("transaction_date"),
    postedDate: date("posted_date"),
    descriptionRaw: text("description_raw").notNull(),
    merchantNormalized: text("merchant_normalized").notNull(),
    amountRaw: text("amount_raw").notNull(),
    amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    direction: text("direction").notNull(),
    suggestedEntryType: entryType("suggested_entry_type"),
    suggestedCategoryId: uuid("suggested_category_id"),
    suggestedCounterAccountId: uuid("suggested_counter_account_id"),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    providerTransactionId: text("provider_transaction_id"),
    rowSignature: text("row_signature").notNull(),
    duplicateCandidateEntryIds: uuid("duplicate_candidate_entry_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    duplicateCandidateRowIds: uuid("duplicate_candidate_row_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    duplicateResolution: duplicateResolution("duplicate_resolution").notNull().default("none"),
    pairing: jsonb("pairing")
      .$type<import("@/lib/imports/types").PairingSuggestion[]>()
      .notNull()
      .default([]),
    softNotes: text("soft_notes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    decision: importDecision("decision").notNull().default("pending"),
    decisionPayload: jsonb("decision_payload")
      .$type<import("@/lib/imports/types").DecisionPayload>()
      .notNull()
      .default({}),
    journalEntryId: uuid("journal_entry_id").unique(),
    linkedEntryId: uuid("linked_entry_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({ columns: [t.ownerId, t.accountId], foreignColumns: [accounts.ownerId, accounts.id] }),
    foreignKey({
      columns: [t.ownerId, t.bankConnectionId],
      foreignColumns: [bankConnections.ownerId, bankConnections.id],
    }),
    uniqueIndex("import_rows_plaid_provider_unique")
      .on(t.ownerId, t.bankConnectionId, t.providerTransactionId)
      .where(sql`${t.bankConnectionId} IS NOT NULL`),
    unique("import_rows_owner_id_unique").on(t.ownerId, t.id),
    unique("import_rows_statement_index_unique").on(t.ownerId, t.statementId, t.rowIndex),
    foreignKey({ columns: [t.ownerId, t.statementId], foreignColumns: [statements.ownerId, statements.id] }),
    foreignKey({
      columns: [t.ownerId, t.journalEntryId],
      foreignColumns: [journalEntries.ownerId, journalEntries.id],
    }),
    foreignKey({
      columns: [t.ownerId, t.linkedEntryId],
      foreignColumns: [journalEntries.ownerId, journalEntries.id],
    }),
    foreignKey({
      columns: [t.ownerId, t.suggestedCategoryId],
      foreignColumns: [categories.ownerId, categories.id],
    }),
    foreignKey({
      columns: [t.ownerId, t.suggestedCounterAccountId],
      foreignColumns: [accounts.ownerId, accounts.id],
    }),
    check("import_rows_one_entry_check", sql`${t.journalEntryId} IS NULL OR ${t.linkedEntryId} IS NULL`),
    check("import_rows_confidence_check", sql`${t.confidence} BETWEEN 0 AND 1`),
  ],
);
export const csvMappings = pgTable(
  "csv_mappings",
  {
    ...owned(),
    accountId: uuid("account_id").notNull(),
    name: text("name").notNull(),
    headerSignature: text("header_signature").notNull(),
    mapping: jsonb("mapping").$type<import("@/lib/imports/types").CsvMapping>().notNull(),
  },
  (t) => [
    unique("csv_mappings_account_header_unique").on(t.ownerId, t.accountId, t.headerSignature),
    foreignKey({ columns: [t.ownerId, t.accountId], foreignColumns: [accounts.ownerId, accounts.id] }),
  ],
);
export const importApprovals = pgTable(
  "import_approvals",
  {
    ...owned(),
    statementId: uuid("statement_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    rowSetHash: text("row_set_hash").notNull(),
    result: jsonb("result").$type<{ rowId: string; entryId: string }[]>().notNull(),
  },
  (t) => [
    unique("import_approvals_key_unique").on(t.ownerId, t.statementId, t.idempotencyKey),
    foreignKey({ columns: [t.ownerId, t.statementId], foreignColumns: [statements.ownerId, statements.id] }),
  ],
);

export const loyaltyProgramKind = pgEnum("loyalty_program_kind", [
  "bank_points",
  "airline",
  "hotel",
  "cashback",
  "other",
]);
export const loyaltyEventType = pgEnum("loyalty_event_type", [
  "earn",
  "bonus",
  "redeem",
  "transfer_out",
  "transfer_in",
  "refund",
  "expire",
  "purchase",
  "adjust",
]);
export const loyaltySource = pgEnum("loyalty_source", ["manual", "statement", "legacy"]);
export const loyaltyPrograms = pgTable(
  "loyalty_programs",
  {
    ...owned(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    kind: loyaltyProgramKind("kind").notNull(),
    unitLabel: text("unit_label").notNull().default("点"),
    isArchived: boolean("is_archived").notNull().default(false),
  },
  (t) => [
    unique("loyalty_programs_owner_id_unique").on(t.ownerId, t.id),
    unique("loyalty_programs_code_unique").on(t.ownerId, t.code),
  ],
);
export const loyaltyAccounts = pgTable(
  "loyalty_accounts",
  {
    ...owned(),
    programId: uuid("program_id").notNull(),
    name: text("name").notNull(),
    memberLast4: char("member_last4", { length: 4 }),
    linkedCardAccountId: uuid("linked_card_account_id"),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
  },
  (t) => [
    unique("loyalty_accounts_owner_id_unique").on(t.ownerId, t.id),
    unique("loyalty_accounts_name_unique").on(t.ownerId, t.programId, t.name),
    foreignKey({
      columns: [t.ownerId, t.programId],
      foreignColumns: [loyaltyPrograms.ownerId, loyaltyPrograms.id],
    }),
    foreignKey({
      columns: [t.ownerId, t.linkedCardAccountId],
      foreignColumns: [accounts.ownerId, accounts.id],
    }),
    check(
      "loyalty_accounts_last4_check",
      sql`${t.memberLast4} IS NULL OR ${t.memberLast4} ~ '^[A-Za-z0-9]{4}$'`,
    ),
  ],
);
export const loyaltyEvents = pgTable(
  "loyalty_events",
  {
    ...owned(),
    loyaltyAccountId: uuid("loyalty_account_id").notNull(),
    eventDate: date("event_date").notNull(),
    pointsDelta: bigint("points_delta", { mode: "bigint" }).notNull(),
    type: loyaltyEventType("type").notNull(),
    transferId: uuid("transfer_id"),
    relatedJournalEntryId: uuid("related_journal_entry_id"),
    statementId: uuid("statement_id"),
    source: loyaltySource("source").notNull().default("manual"),
    externalReference: text("external_reference"),
    note: text("note"),
  },
  (t) => [
    unique("loyalty_events_owner_id_unique").on(t.ownerId, t.id),
    foreignKey({
      columns: [t.ownerId, t.loyaltyAccountId],
      foreignColumns: [loyaltyAccounts.ownerId, loyaltyAccounts.id],
    }),
    foreignKey({
      columns: [t.ownerId, t.relatedJournalEntryId],
      foreignColumns: [journalEntries.ownerId, journalEntries.id],
    }),
    foreignKey({ columns: [t.ownerId, t.statementId], foreignColumns: [statements.ownerId, statements.id] }),
    uniqueIndex("loyalty_events_statement_unique")
      .on(t.ownerId, t.statementId)
      .where(sql`${t.source} = 'statement'`),
    index("loyalty_events_account_date_idx").on(t.ownerId, t.loyaltyAccountId, t.eventDate),
    check("loyalty_events_nonzero_check", sql`${t.pointsDelta} <> 0`),
    check(
      "loyalty_events_sign_check",
      sql`(${t.type} IN ('redeem','expire','transfer_out') AND ${t.pointsDelta} < 0) OR (${t.type} IN ('earn','bonus','refund','purchase','transfer_in') AND ${t.pointsDelta} > 0) OR ${t.type} = 'adjust'`,
    ),
    check(
      "loyalty_events_transfer_check",
      sql`(${t.type} IN ('transfer_out','transfer_in')) = (${t.transferId} IS NOT NULL)`,
    ),
  ],
);
export const loyaltyTransfers = pgTable(
  "loyalty_transfers",
  {
    ...owned(),
    fromEventId: uuid("from_event_id").notNull(),
    toEventId: uuid("to_event_id").notNull(),
    ratioFrom: bigint("ratio_from", { mode: "bigint" }).notNull(),
    ratioTo: bigint("ratio_to", { mode: "bigint" }).notNull(),
    note: text("note"),
  },
  (t) => [
    foreignKey({
      columns: [t.ownerId, t.fromEventId],
      foreignColumns: [loyaltyEvents.ownerId, loyaltyEvents.id],
    }),
    foreignKey({
      columns: [t.ownerId, t.toEventId],
      foreignColumns: [loyaltyEvents.ownerId, loyaltyEvents.id],
    }),
    unique("loyalty_transfers_from_unique").on(t.ownerId, t.fromEventId),
    unique("loyalty_transfers_to_unique").on(t.ownerId, t.toEventId),
    check(
      "loyalty_transfers_ratio_check",
      sql`${t.ratioFrom} > 0 AND ${t.ratioTo} > 0 AND ${t.fromEventId} <> ${t.toEventId}`,
    ),
  ],
);
export const loyaltyObservations = pgTable(
  "loyalty_observations",
  {
    ...owned(),
    loyaltyAccountId: uuid("loyalty_account_id").notNull(),
    observedOn: date("observed_on").notNull(),
    balance: bigint("balance", { mode: "bigint" }).notNull(),
    source: loyaltySource("source").notNull().default("manual"),
    statementId: uuid("statement_id"),
  },
  (t) => [
    foreignKey({
      columns: [t.ownerId, t.loyaltyAccountId],
      foreignColumns: [loyaltyAccounts.ownerId, loyaltyAccounts.id],
    }),
    foreignKey({ columns: [t.ownerId, t.statementId], foreignColumns: [statements.ownerId, statements.id] }),
    unique("loyalty_observations_account_date_unique").on(t.ownerId, t.loyaltyAccountId, t.observedOn),
    uniqueIndex("loyalty_observations_statement_unique")
      .on(t.ownerId, t.statementId)
      .where(sql`${t.source} = 'statement'`),
  ],
);
export const loyaltyCppHistory = pgTable(
  "loyalty_cpp_history",
  {
    ...owned(),
    programId: uuid("program_id").notNull(),
    effectiveDate: date("effective_date").notNull(),
    cppBaseline: numeric("cpp_baseline", { precision: 10, scale: 4 }).notNull(),
    cppPersonal: numeric("cpp_personal", { precision: 10, scale: 4 }).notNull(),
    source: text("source", { enum: ["user", "legacy", "default"] }).notNull(),
    note: text("note"),
  },
  (t) => [
    foreignKey({
      columns: [t.ownerId, t.programId],
      foreignColumns: [loyaltyPrograms.ownerId, loyaltyPrograms.id],
    }),
    unique("loyalty_cpp_program_date_unique").on(t.ownerId, t.programId, t.effectiveDate),
    check("loyalty_cpp_nonnegative_check", sql`${t.cppBaseline} >= 0 AND ${t.cppPersonal} >= 0`),
  ],
);
