ALTER TYPE "public"."import_job_kind" ADD VALUE 'plaid_sync';--> statement-breakpoint
ALTER TYPE "public"."snapshot_source" ADD VALUE 'plaid';--> statement-breakpoint
CREATE TABLE "bank_connection_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"connection_id" uuid NOT NULL,
	"plaid_account_id" text NOT NULL,
	"name" text NOT NULL,
	"official_name" text,
	"mask" text,
	"type" text NOT NULL,
	"subtype" text,
	"currency" char(3),
	"account_id" uuid,
	"security_account_id" uuid,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"last_balance_current" numeric(20, 4),
	"last_balance_available" numeric(20, 4),
	"last_balance_limit" numeric(20, 4),
	"last_balance_at" timestamp with time zone,
	CONSTRAINT "bank_accounts_provider_unique" UNIQUE("connection_id","plaid_account_id"),
	CONSTRAINT "bank_accounts_ledger_unique" UNIQUE("owner_id","account_id"),
	CONSTRAINT "bank_accounts_security_unique" UNIQUE("owner_id","security_account_id")
);
--> statement-breakpoint
CREATE TABLE "bank_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text DEFAULT 'plaid' NOT NULL,
	"environment" text NOT NULL,
	"plaid_item_id" text NOT NULL,
	"institution_id" text,
	"institution_name" text NOT NULL,
	"products" text[] DEFAULT '{}'::text[] NOT NULL,
	"access_token_enc" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"error_code" text,
	"consent_expires_at" timestamp with time zone,
	"transactions_cursor" text,
	"import_from_date" date NOT NULL,
	"mapping_confirmed_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_requested_at" timestamp with time zone,
	CONSTRAINT "bank_connections_owner_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "bank_connections_item_unique" UNIQUE("owner_id","environment","plaid_item_id")
);
--> statement-breakpoint
ALTER TABLE "statements" DROP CONSTRAINT "statements_owner_hash_unique";--> statement-breakpoint
ALTER TABLE "import_jobs" ALTER COLUMN "statement_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "statements" ALTER COLUMN "file_sha256" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "statements" ALTER COLUMN "original_filename" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "statements" ALTER COLUMN "mime" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "statements" ALTER COLUMN "size_bytes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "import_rows" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "import_rows" ADD COLUMN "bank_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "import_rows" ADD COLUMN "upstream_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_rows" ADD COLUMN "upstream_payload" jsonb;--> statement-breakpoint
ALTER TABLE "statements" ADD COLUMN "source" text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "statements" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "statements" ADD COLUMN "sync_date" date;--> statement-breakpoint
ALTER TABLE "statements" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "bank_connection_accounts" ADD CONSTRAINT "bank_connection_accounts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_connection_accounts" ADD CONSTRAINT "bank_connection_accounts_owner_id_connection_id_bank_connections_owner_id_id_fk" FOREIGN KEY ("owner_id","connection_id") REFERENCES "public"."bank_connections"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_connection_accounts" ADD CONSTRAINT "bank_connection_accounts_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_connection_accounts" ADD CONSTRAINT "bank_connection_accounts_owner_id_security_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","security_account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD CONSTRAINT "bank_connections_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_owner_id_connection_id_bank_connections_owner_id_id_fk" FOREIGN KEY ("owner_id","connection_id") REFERENCES "public"."bank_connections"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_owner_id_bank_connection_id_bank_connections_owner_id_id_fk" FOREIGN KEY ("owner_id","bank_connection_id") REFERENCES "public"."bank_connections"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statements" ADD CONSTRAINT "statements_owner_id_connection_id_bank_connections_owner_id_id_fk" FOREIGN KEY ("owner_id","connection_id") REFERENCES "public"."bank_connections"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "balance_snapshots_plaid_date_unique" ON "balance_snapshots" USING btree ("owner_id","source","snapshot_date") WHERE "balance_snapshots"."source" NOT IN ('manual', 'legacy_xlsx', 'statement');--> statement-breakpoint
CREATE UNIQUE INDEX "import_jobs_active_connection_unique" ON "import_jobs" USING btree ("owner_id","connection_id") WHERE "import_jobs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "import_rows_plaid_provider_unique" ON "import_rows" USING btree ("owner_id","bank_connection_id","provider_transaction_id") WHERE "import_rows"."bank_connection_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "statements_owner_hash_unique" ON "statements" USING btree ("owner_id","file_sha256") WHERE "statements"."file_sha256" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "statements" ADD CONSTRAINT "statements_connection_date_unique" UNIQUE("owner_id","connection_id","sync_date");--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_target_check" CHECK (("import_jobs"."kind"::text = 'plaid_sync' AND "import_jobs"."connection_id" IS NOT NULL AND "import_jobs"."statement_id" IS NULL) OR ("import_jobs"."kind"::text <> 'plaid_sync' AND "import_jobs"."statement_id" IS NOT NULL AND "import_jobs"."connection_id" IS NULL));--> statement-breakpoint
ALTER TABLE "statements" ADD CONSTRAINT "statements_source_check" CHECK (("statements"."source" = 'upload' AND "statements"."file_sha256" IS NOT NULL AND "statements"."mime" IS NOT NULL AND "statements"."original_filename" IS NOT NULL AND "statements"."size_bytes" IS NOT NULL) OR ("statements"."source" = 'plaid' AND "statements"."connection_id" IS NOT NULL AND "statements"."sync_date" IS NOT NULL AND "statements"."file_sha256" IS NULL AND "statements"."storage_path" IS NULL));