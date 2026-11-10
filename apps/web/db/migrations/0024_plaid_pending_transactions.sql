CREATE TABLE "plaid_pending_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"connection_id" uuid NOT NULL,
	"plaid_account_id" text NOT NULL,
	"provider_transaction_id" text NOT NULL,
	"transaction_date" date NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"merchant" text NOT NULL,
	"description" text NOT NULL,
	CONSTRAINT "plaid_pending_provider_unique" UNIQUE("owner_id","connection_id","provider_transaction_id")
);
--> statement-breakpoint
ALTER TABLE "plaid_pending_transactions" ADD CONSTRAINT "plaid_pending_transactions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_pending_transactions" ADD CONSTRAINT "plaid_pending_transactions_owner_id_connection_id_bank_connections_owner_id_id_fk" FOREIGN KEY ("owner_id","connection_id") REFERENCES "public"."bank_connections"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_pending_transactions" ADD CONSTRAINT "plaid_pending_transactions_connection_id_plaid_account_id_bank_connection_accounts_connection_id_plaid_account_id_fk" FOREIGN KEY ("connection_id","plaid_account_id") REFERENCES "public"."bank_connection_accounts"("connection_id","plaid_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plaid_pending_owner_date_idx" ON "plaid_pending_transactions" USING btree ("owner_id","transaction_date");