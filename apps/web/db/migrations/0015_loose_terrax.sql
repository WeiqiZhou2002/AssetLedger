CREATE TABLE "account_card_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"account_id" uuid NOT NULL,
	"payload_enc" text NOT NULL,
	"number_last4" text NOT NULL,
	"network" text NOT NULL,
	"has_expiry" boolean NOT NULL,
	"has_cvv" boolean NOT NULL,
	"has_cid" boolean NOT NULL,
	CONSTRAINT "account_card_secrets_account_unique" UNIQUE("owner_id","account_id"),
	CONSTRAINT "account_card_secrets_last4_check" CHECK ("account_card_secrets"."number_last4" ~ '^[0-9]{4}$'),
	CONSTRAINT "account_card_secrets_network_check" CHECK ("account_card_secrets"."network" IN ('visa','mastercard','amex','discover','other'))
);
--> statement-breakpoint
ALTER TABLE "account_card_secrets" ADD CONSTRAINT "account_card_secrets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_card_secrets" ADD CONSTRAINT "account_card_secrets_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE cascade ON UPDATE no action;