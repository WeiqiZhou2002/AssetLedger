CREATE TYPE "public"."legacy_status" AS ENUM('uploaded', 'reviewing', 'committed');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_scope" AS ENUM('cash_like', 'financial', 'global');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('open', 'resolved', 'wont_fix');--> statement-breakpoint
CREATE TYPE "public"."snapshot_source" AS ENUM('manual', 'legacy_xlsx', 'statement');--> statement-breakpoint
CREATE TYPE "public"."snapshot_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TABLE "balance_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"snapshot_date" date NOT NULL,
	"label" text NOT NULL,
	"source" "snapshot_source" DEFAULT 'manual' NOT NULL,
	"status" "snapshot_status" DEFAULT 'draft' NOT NULL,
	"base_currency" char(3) NOT NULL,
	"is_complete" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"legacy_import_id" uuid,
	"legacy_sheet_name" text,
	"published_at" timestamp with time zone,
	CONSTRAINT "balance_snapshots_owner_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "balance_snapshots_legacy_unique" UNIQUE("owner_id","legacy_import_id","legacy_sheet_name")
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"base_currency" char(3) NOT NULL,
	"quote_currency" char(3) NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"observed_on" date NOT NULL,
	"source" text NOT NULL,
	"is_manual" boolean DEFAULT true NOT NULL,
	CONSTRAINT "fx_rates_owner_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "fx_rates_positive_check" CHECK ("fx_rates"."rate" > 0),
	CONSTRAINT "fx_rates_currency_check" CHECK ("fx_rates"."base_currency" ~ '^[A-Z]{3}$' AND "fx_rates"."quote_currency" ~ '^[A-Z]{3}$' AND "fx_rates"."base_currency" <> "fx_rates"."quote_currency")
);
--> statement-breakpoint
CREATE TABLE "legacy_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"file_sha256" text NOT NULL,
	"filename" text NOT NULL,
	"status" "legacy_status" DEFAULT 'uploaded' NOT NULL,
	"sheet_count" integer NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "legacy_imports_owner_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "legacy_imports_hash_unique" UNIQUE("owner_id","file_sha256")
);
--> statement-breakpoint
CREATE TABLE "legacy_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"layout_signature" text NOT NULL,
	"mapping" jsonb NOT NULL,
	CONSTRAINT "legacy_mappings_signature_unique" UNIQUE("owner_id","layout_signature")
);
--> statement-breakpoint
CREATE TABLE "legacy_points_valuations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"program_label" text NOT NULL,
	"value_usd" numeric(20, 4) NOT NULL,
	"formula" text,
	"suggested_points" bigint,
	"needs_confirmation" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_snapshot_id" uuid NOT NULL,
	"to_snapshot_id" uuid NOT NULL,
	"account_id" uuid,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"review_status" "review_status" DEFAULT 'open' NOT NULL,
	"linked_entry_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_snapshot_id" uuid NOT NULL,
	"to_snapshot_id" uuid NOT NULL,
	"scope" "reconciliation_scope" NOT NULL,
	"engine_version" text NOT NULL,
	"result" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshot_fx" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"quote_currency" char(3) NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"observed_on" date NOT NULL,
	"source" text NOT NULL,
	"fx_rate_id" uuid,
	CONSTRAINT "snapshot_fx_currency_unique" UNIQUE("owner_id","snapshot_id","quote_currency"),
	CONSTRAINT "snapshot_fx_rate_check" CHECK ("snapshot_fx"."rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "snapshot_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"account_id" uuid,
	"account_group_id" uuid,
	"balance_native" numeric(20, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"source_ref" text,
	"version" integer DEFAULT 1 NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"superseded_at" timestamp with time zone,
	"notes" text,
	CONSTRAINT "snapshot_items_target_check" CHECK (("snapshot_items"."account_id" IS NOT NULL)::int + ("snapshot_items"."account_group_id" IS NOT NULL)::int = 1),
	CONSTRAINT "snapshot_items_version_check" CHECK ("snapshot_items"."version" > 0),
	CONSTRAINT "snapshot_items_currency_check" CHECK ("snapshot_items"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "account_groups" ADD COLUMN "currency" char(3) DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "account_groups" ADD COLUMN "cash_like_inclusion" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "account_groups" ADD COLUMN "financial_inclusion" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "account_groups" ADD COLUMN "is_security" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "account_groups" ADD COLUMN "needs_mapping" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_owner_id_legacy_import_id_legacy_imports_owner_id_id_fk" FOREIGN KEY ("owner_id","legacy_import_id") REFERENCES "public"."legacy_imports"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_imports" ADD CONSTRAINT "legacy_imports_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_mappings" ADD CONSTRAINT "legacy_mappings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_points_valuations" ADD CONSTRAINT "legacy_points_valuations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_points_valuations" ADD CONSTRAINT "legacy_points_valuations_owner_id_snapshot_id_balance_snapshots_owner_id_id_fk" FOREIGN KEY ("owner_id","snapshot_id") REFERENCES "public"."balance_snapshots"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_notes" ADD CONSTRAINT "reconciliation_notes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_notes" ADD CONSTRAINT "reconciliation_notes_owner_id_from_snapshot_id_balance_snapshots_owner_id_id_fk" FOREIGN KEY ("owner_id","from_snapshot_id") REFERENCES "public"."balance_snapshots"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_notes" ADD CONSTRAINT "reconciliation_notes_owner_id_to_snapshot_id_balance_snapshots_owner_id_id_fk" FOREIGN KEY ("owner_id","to_snapshot_id") REFERENCES "public"."balance_snapshots"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_notes" ADD CONSTRAINT "reconciliation_notes_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_owner_id_from_snapshot_id_balance_snapshots_owner_id_id_fk" FOREIGN KEY ("owner_id","from_snapshot_id") REFERENCES "public"."balance_snapshots"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_owner_id_to_snapshot_id_balance_snapshots_owner_id_id_fk" FOREIGN KEY ("owner_id","to_snapshot_id") REFERENCES "public"."balance_snapshots"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_fx" ADD CONSTRAINT "snapshot_fx_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_fx" ADD CONSTRAINT "snapshot_fx_owner_id_snapshot_id_balance_snapshots_owner_id_id_fk" FOREIGN KEY ("owner_id","snapshot_id") REFERENCES "public"."balance_snapshots"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_fx" ADD CONSTRAINT "snapshot_fx_owner_id_fx_rate_id_fx_rates_owner_id_id_fk" FOREIGN KEY ("owner_id","fx_rate_id") REFERENCES "public"."fx_rates"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_items" ADD CONSTRAINT "snapshot_items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_items" ADD CONSTRAINT "snapshot_items_owner_id_snapshot_id_balance_snapshots_owner_id_id_fk" FOREIGN KEY ("owner_id","snapshot_id") REFERENCES "public"."balance_snapshots"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_items" ADD CONSTRAINT "snapshot_items_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_items" ADD CONSTRAINT "snapshot_items_owner_id_account_group_id_account_groups_owner_id_id_fk" FOREIGN KEY ("owner_id","account_group_id") REFERENCES "public"."account_groups"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "balance_snapshots_owner_date_idx" ON "balance_snapshots" USING btree ("owner_id","snapshot_date");--> statement-breakpoint
CREATE INDEX "fx_rates_lookup_idx" ON "fx_rates" USING btree ("owner_id","base_currency","quote_currency","observed_on");--> statement-breakpoint
CREATE INDEX "reconciliation_runs_owner_idx" ON "reconciliation_runs" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "snapshot_items_current_account_unique" ON "snapshot_items" USING btree ("owner_id","snapshot_id","account_id") WHERE "snapshot_items"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "snapshot_items_current_group_unique" ON "snapshot_items" USING btree ("owner_id","snapshot_id","account_group_id") WHERE "snapshot_items"."is_current";--> statement-breakpoint
ALTER TABLE "account_groups" ADD CONSTRAINT "account_groups_owner_name_unique" UNIQUE("owner_id","name");--> statement-breakpoint
ALTER TABLE "account_groups" ADD CONSTRAINT "account_groups_currency_check" CHECK ("account_groups"."currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "account_groups" ADD CONSTRAINT "account_groups_security_check" CHECK (NOT "account_groups"."is_security" OR NOT "account_groups"."cash_like_inclusion");