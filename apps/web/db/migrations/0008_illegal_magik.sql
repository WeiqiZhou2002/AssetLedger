ALTER TYPE "public"."account_type" ADD VALUE 'transfer_clearing' BEFORE 'reconciliation_adjustment';--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_system_check";--> statement-breakpoint
ALTER TABLE "bank_connections" ADD COLUMN "auto_post" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "import_rows" ADD COLUMN "auto_post_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "transfer_match_id" uuid;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "auto_posted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "auto_post_fingerprint" text;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "auto_post_owner_edited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "journal_entries_transfer_match_idx" ON "journal_entries" USING btree ("owner_id","transfer_match_id");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_system_check" CHECK ("accounts"."is_system" = ("accounts"."type"::text IN ('income','expense','equity_opening','fx_clearing','transfer_clearing','reconciliation_adjustment')));