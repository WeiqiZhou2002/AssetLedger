CREATE TABLE "card_benefit_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"account_id" uuid NOT NULL,
	"catalog_product_id" text NOT NULL,
	"tracking_start" date,
	CONSTRAINT "card_benefit_profiles_account_unique" UNIQUE("owner_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "card_benefit_profiles" ADD CONSTRAINT "card_benefit_profiles_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_benefit_profiles" ADD CONSTRAINT "card_benefit_profiles_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;