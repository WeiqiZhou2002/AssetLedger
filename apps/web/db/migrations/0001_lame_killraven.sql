CREATE TYPE "public"."account_type" AS ENUM('asset_cash', 'asset_brokerage_cash', 'asset_security', 'asset_receivable', 'asset_prepaid', 'liability_credit_card', 'liability_loan', 'income', 'expense', 'equity_opening', 'fx_clearing', 'reconciliation_adjustment');--> statement-breakpoint
CREATE TYPE "public"."category_kind" AS ENUM('expense', 'income');--> statement-breakpoint
CREATE TYPE "public"."date_basis" AS ENUM('posted', 'event');--> statement-breakpoint
CREATE TYPE "public"."entry_source" AS ENUM('manual', 'import', 'legacy', 'system');--> statement-breakpoint
CREATE TYPE "public"."entry_status" AS ENUM('draft', 'confirmed', 'voided');--> statement-breakpoint
CREATE TYPE "public"."entry_type" AS ENUM('expense', 'income', 'transfer', 'credit_card_payment', 'refund', 'investment_buy', 'investment_sell', 'loan_out', 'loan_repayment', 'prepayment', 'fee', 'interest', 'balance_adjustment', 'opening_balance');--> statement-breakpoint
CREATE TYPE "public"."institution_kind" AS ENUM('bank', 'card_issuer', 'brokerage', 'wallet', 'other');--> statement-breakpoint
CREATE TYPE "public"."prepayment_mode" AS ENUM('asset', 'expense');--> statement-breakpoint
CREATE TABLE "account_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	CONSTRAINT "account_groups_owner_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"institution_id" uuid,
	"account_group_id" uuid,
	"name" text NOT NULL,
	"type" "account_type" NOT NULL,
	"currency" char(3) NOT NULL,
	"last4" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"cash_like_inclusion" boolean DEFAULT false NOT NULL,
	"financial_inclusion" boolean DEFAULT true NOT NULL,
	"opened_on" date,
	"closed_on" date,
	"statement_day" integer,
	"payment_due_day" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"notes" text,
	CONSTRAINT "accounts_owner_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "accounts_owner_name_unique" UNIQUE("owner_id","name"),
	CONSTRAINT "accounts_last4_check" CHECK ("accounts"."last4" IS NULL OR "accounts"."last4" ~ '^[0-9]{4}$'),
	CONSTRAINT "accounts_currency_check" CHECK ("accounts"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "accounts_days_check" CHECK (("accounts"."statement_day" IS NULL OR "accounts"."statement_day" BETWEEN 1 AND 31) AND ("accounts"."payment_due_day" IS NULL OR "accounts"."payment_due_day" BETWEEN 1 AND 31)),
	CONSTRAINT "accounts_dates_check" CHECK ("accounts"."opened_on" IS NULL OR "accounts"."closed_on" IS NULL OR "accounts"."closed_on" >= "accounts"."opened_on"),
	CONSTRAINT "accounts_system_check" CHECK ("accounts"."is_system" = ("accounts"."type" IN ('income','expense','equity_opening','fx_clearing','reconciliation_adjustment'))),
	CONSTRAINT "accounts_inclusion_check" CHECK (NOT "accounts"."cash_like_inclusion" OR "accounts"."type" IN ('asset_cash','asset_brokerage_cash','liability_credit_card','liability_loan'))
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"kind" "category_kind" NOT NULL,
	"icon" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	CONSTRAINT "categories_owner_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "categories_owner_kind_name_unique" UNIQUE("owner_id","kind","name")
);
--> statement-breakpoint
CREATE TABLE "institutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"kind" "institution_kind" NOT NULL,
	"parser_key" text,
	"notes" text,
	CONSTRAINT "institutions_owner_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "institutions_owner_name_unique" UNIQUE("owner_id","name")
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entry_type" "entry_type" NOT NULL,
	"status" "entry_status" DEFAULT 'draft' NOT NULL,
	"event_date" date NOT NULL,
	"posted_date" date,
	"merchant" text,
	"description" text,
	"notes" text,
	"source" "entry_source" DEFAULT 'manual' NOT NULL,
	"purchase_group_id" uuid,
	"replaces_entry_id" uuid,
	"refund_of_entry_id" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"external_reference" text,
	CONSTRAINT "journal_entries_owner_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
CREATE TABLE "postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"category_id" uuid,
	"amount" numeric(20, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"memo" text,
	CONSTRAINT "postings_nonzero_check" CHECK ("postings"."amount" <> 0),
	CONSTRAINT "postings_currency_check" CHECK ("postings"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "purchase_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"confirmed_total" numeric(20, 4),
	"currency" char(3) NOT NULL,
	"category_id" uuid,
	"notes" text,
	CONSTRAINT "purchase_groups_owner_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "purchase_groups_total_check" CHECK ("purchase_groups"."confirmed_total" IS NULL OR "purchase_groups"."confirmed_total" >= 0),
	CONSTRAINT "purchase_groups_currency_check" CHECK ("purchase_groups"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prepayment_mode" "prepayment_mode" DEFAULT 'asset' NOT NULL,
	"spending_date_basis" date_basis DEFAULT 'posted' NOT NULL,
	CONSTRAINT "user_settings_owner_unique" UNIQUE("owner_id")
);
--> statement-breakpoint
ALTER TABLE "account_groups" ADD CONSTRAINT "account_groups_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_id_institution_id_institutions_owner_id_id_fk" FOREIGN KEY ("owner_id","institution_id") REFERENCES "public"."institutions"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_id_account_group_id_account_groups_owner_id_id_fk" FOREIGN KEY ("owner_id","account_group_id") REFERENCES "public"."account_groups"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_owner_id_parent_id_categories_owner_id_id_fk" FOREIGN KEY ("owner_id","parent_id") REFERENCES "public"."categories"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_owner_id_purchase_group_id_purchase_groups_owner_id_id_fk" FOREIGN KEY ("owner_id","purchase_group_id") REFERENCES "public"."purchase_groups"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_owner_id_replaces_entry_id_journal_entries_owner_id_id_fk" FOREIGN KEY ("owner_id","replaces_entry_id") REFERENCES "public"."journal_entries"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_owner_id_refund_of_entry_id_journal_entries_owner_id_id_fk" FOREIGN KEY ("owner_id","refund_of_entry_id") REFERENCES "public"."journal_entries"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postings" ADD CONSTRAINT "postings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postings" ADD CONSTRAINT "postings_owner_id_journal_entry_id_journal_entries_owner_id_id_fk" FOREIGN KEY ("owner_id","journal_entry_id") REFERENCES "public"."journal_entries"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postings" ADD CONSTRAINT "postings_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postings" ADD CONSTRAINT "postings_owner_id_category_id_categories_owner_id_id_fk" FOREIGN KEY ("owner_id","category_id") REFERENCES "public"."categories"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_groups" ADD CONSTRAINT "purchase_groups_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_groups" ADD CONSTRAINT "purchase_groups_owner_id_category_id_categories_owner_id_id_fk" FOREIGN KEY ("owner_id","category_id") REFERENCES "public"."categories"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_system_unique" ON "accounts" USING btree ("owner_id","type","currency") WHERE "accounts"."is_system" = true;--> statement-breakpoint
CREATE INDEX "journal_entries_owner_date_idx" ON "journal_entries" USING btree ("owner_id","event_date");--> statement-breakpoint
CREATE INDEX "journal_entries_owner_posted_idx" ON "journal_entries" USING btree ("owner_id","posted_date");--> statement-breakpoint
CREATE INDEX "journal_entries_group_idx" ON "journal_entries" USING btree ("owner_id","purchase_group_id");--> statement-breakpoint
CREATE INDEX "postings_account_idx" ON "postings" USING btree ("owner_id","account_id");--> statement-breakpoint
CREATE INDEX "postings_entry_idx" ON "postings" USING btree ("owner_id","journal_entry_id");