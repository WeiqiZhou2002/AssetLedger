ALTER TABLE "bank_connection_accounts" ADD COLUMN "account_created_here" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "plaid_institution_id" text;--> statement-breakpoint
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_owner_plaid_unique" UNIQUE("owner_id","plaid_institution_id");