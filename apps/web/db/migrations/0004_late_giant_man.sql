CREATE TYPE "public"."duplicate_resolution" AS ENUM('none', 'distinct', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."import_decision" AS ENUM('pending', 'approve', 'exclude', 'link_existing');--> statement-breakpoint
CREATE TYPE "public"."import_job_kind" AS ENUM('pdf', 'csv', 'ai_parse', 'render');--> statement-breakpoint
CREATE TYPE "public"."import_job_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."statement_status" AS ENUM('uploaded', 'queued', 'parsing', 'needs_mapping', 'needs_review', 'approved', 'failed', 'discarded');--> statement-breakpoint
CREATE TABLE "csv_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"header_signature" text NOT NULL,
	"mapping" jsonb NOT NULL,
	CONSTRAINT "csv_mappings_account_header_unique" UNIQUE("owner_id","account_id","header_signature")
);
--> statement-breakpoint
CREATE TABLE "import_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"statement_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"row_set_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	CONSTRAINT "import_approvals_key_unique" UNIQUE("owner_id","statement_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"statement_id" uuid NOT NULL,
	"kind" "import_job_kind" NOT NULL,
	"status" "import_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"error_kind" text,
	"progress" integer DEFAULT 0 NOT NULL,
	"consent" jsonb,
	CONSTRAINT "import_jobs_progress_check" CHECK ("import_jobs"."progress" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"statement_id" uuid NOT NULL,
	"row_index" integer NOT NULL,
	"source_page" integer,
	"source_row_text" text NOT NULL,
	"source" text DEFAULT 'parser' NOT NULL,
	"transaction_date" date,
	"posted_date" date,
	"description_raw" text NOT NULL,
	"merchant_normalized" text NOT NULL,
	"amount_raw" text NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"direction" text NOT NULL,
	"suggested_entry_type" "entry_type",
	"suggested_category_id" uuid,
	"suggested_counter_account_id" uuid,
	"confidence" numeric(4, 3) NOT NULL,
	"provider_transaction_id" text,
	"row_signature" text NOT NULL,
	"duplicate_candidate_entry_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"duplicate_candidate_row_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"duplicate_resolution" "duplicate_resolution" DEFAULT 'none' NOT NULL,
	"pairing" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"soft_notes" text[] DEFAULT '{}'::text[] NOT NULL,
	"decision" "import_decision" DEFAULT 'pending' NOT NULL,
	"decision_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"journal_entry_id" uuid,
	"linked_entry_id" uuid,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "import_rows_journal_entry_id_unique" UNIQUE("journal_entry_id"),
	CONSTRAINT "import_rows_owner_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "import_rows_statement_index_unique" UNIQUE("owner_id","statement_id","row_index"),
	CONSTRAINT "import_rows_one_entry_check" CHECK ("import_rows"."journal_entry_id" IS NULL OR "import_rows"."linked_entry_id" IS NULL),
	CONSTRAINT "import_rows_confidence_check" CHECK ("import_rows"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"account_id" uuid,
	"institution_id" uuid,
	"file_sha256" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"page_count" integer,
	"storage_path" text,
	"status" "statement_status" DEFAULT 'uploaded' NOT NULL,
	"statement_type" text DEFAULT 'unknown' NOT NULL,
	"issuer" text,
	"account_last4" text,
	"period_start" date,
	"period_end" date,
	"currency" char(3),
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parser" text,
	"parser_version" text,
	"ai_used" boolean DEFAULT false NOT NULL,
	"diagnostics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"transaction_lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"delete_file_after" timestamp with time zone,
	CONSTRAINT "statements_owner_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "statements_owner_hash_unique" UNIQUE("owner_id","file_sha256"),
	CONSTRAINT "statements_last4_check" CHECK ("statements"."account_last4" IS NULL OR "statements"."account_last4" ~ '^[0-9]{4}$'),
	CONSTRAINT "statements_size_check" CHECK ("statements"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "provider_transaction_id" text;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "provider_account_id" uuid;--> statement-breakpoint
ALTER TABLE "csv_mappings" ADD CONSTRAINT "csv_mappings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_mappings" ADD CONSTRAINT "csv_mappings_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_approvals" ADD CONSTRAINT "import_approvals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_approvals" ADD CONSTRAINT "import_approvals_owner_id_statement_id_statements_owner_id_id_fk" FOREIGN KEY ("owner_id","statement_id") REFERENCES "public"."statements"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_owner_id_statement_id_statements_owner_id_id_fk" FOREIGN KEY ("owner_id","statement_id") REFERENCES "public"."statements"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_owner_id_statement_id_statements_owner_id_id_fk" FOREIGN KEY ("owner_id","statement_id") REFERENCES "public"."statements"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_owner_id_journal_entry_id_journal_entries_owner_id_id_fk" FOREIGN KEY ("owner_id","journal_entry_id") REFERENCES "public"."journal_entries"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_owner_id_linked_entry_id_journal_entries_owner_id_id_fk" FOREIGN KEY ("owner_id","linked_entry_id") REFERENCES "public"."journal_entries"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_owner_id_suggested_category_id_categories_owner_id_id_fk" FOREIGN KEY ("owner_id","suggested_category_id") REFERENCES "public"."categories"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_owner_id_suggested_counter_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","suggested_counter_account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statements" ADD CONSTRAINT "statements_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statements" ADD CONSTRAINT "statements_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statements" ADD CONSTRAINT "statements_owner_id_institution_id_institutions_owner_id_id_fk" FOREIGN KEY ("owner_id","institution_id") REFERENCES "public"."institutions"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_jobs_poll_idx" ON "import_jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "import_jobs_active_unique" ON "import_jobs" USING btree ("owner_id","statement_id") WHERE "import_jobs"."status" IN ('queued', 'running');--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_owner_id_provider_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","provider_account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_provider_unique" ON "journal_entries" USING btree ("owner_id","provider_account_id","provider_transaction_id") WHERE "journal_entries"."provider_account_id" IS NOT NULL AND "journal_entries"."provider_transaction_id" IS NOT NULL;