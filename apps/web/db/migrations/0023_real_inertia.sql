ALTER TABLE "bank_connection_accounts" ADD COLUMN "unshared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD COLUMN "new_accounts_available_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD COLUMN "new_accounts_handled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD COLUMN "webhook_url" text;