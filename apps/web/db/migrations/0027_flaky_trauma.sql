CREATE TABLE "card_benefit_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entry_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"catalog_product_id" text NOT NULL,
	"credit_id" text,
	CONSTRAINT "card_benefit_assignments_entry_product_unique" UNIQUE("owner_id","entry_id","catalog_product_id")
);
--> statement-breakpoint
ALTER TABLE "card_benefit_assignments" ADD CONSTRAINT "card_benefit_assignments_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_benefit_assignments" ADD CONSTRAINT "card_benefit_assignments_owner_id_entry_id_journal_entries_owner_id_id_fk" FOREIGN KEY ("owner_id","entry_id") REFERENCES "public"."journal_entries"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_benefit_assignments" ADD CONSTRAINT "card_benefit_assignments_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;