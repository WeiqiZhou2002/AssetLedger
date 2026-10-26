CREATE TABLE "plaid_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"environment" text NOT NULL,
	"client_id" text NOT NULL,
	"secret_enc" text NOT NULL,
	"redirect_uri" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "plaid_settings_owner_unique" UNIQUE("owner_id"),
	CONSTRAINT "plaid_settings_environment_check" CHECK ("plaid_settings"."environment" IN ('sandbox', 'production')),
	CONSTRAINT "plaid_settings_verified_check" CHECK (NOT "plaid_settings"."enabled" OR "plaid_settings"."verified_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "setup_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "setup_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "plaid_settings" ADD CONSTRAINT "plaid_settings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;