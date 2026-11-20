CREATE TABLE "card_benefit_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"account_id" uuid NOT NULL,
	"catalog_product_id" text NOT NULL,
	"credit_id" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	CONSTRAINT "card_benefit_marks_period_unique" UNIQUE("owner_id","account_id","catalog_product_id","credit_id","period_start"),
	CONSTRAINT "card_benefit_marks_period_check" CHECK ("card_benefit_marks"."period_end" >= "card_benefit_marks"."period_start")
);
--> statement-breakpoint
ALTER TABLE "card_benefit_profiles" ALTER COLUMN "catalog_product_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "card_benefit_marks" ADD CONSTRAINT "card_benefit_marks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_benefit_marks" ADD CONSTRAINT "card_benefit_marks_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;