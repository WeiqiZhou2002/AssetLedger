ALTER TABLE "bank_connections" ADD COLUMN "benefit_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "benefit_credit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "benefit_family" text;