CREATE TABLE "bank_reset_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"storage_path" text,
	"expires_at" timestamp with time zone NOT NULL,
	"counts" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_category_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"merchant" text NOT NULL,
	"account_type" "account_type" NOT NULL,
	"category_id" uuid NOT NULL,
	"source" text NOT NULL,
	"last_used" timestamp with time zone NOT NULL,
	CONSTRAINT "merchant_memory_key_unique" UNIQUE("owner_id","merchant","account_type")
);
--> statement-breakpoint
ALTER TABLE "bank_reset_exports" ADD CONSTRAINT "bank_reset_exports_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_category_memory" ADD CONSTRAINT "merchant_category_memory_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_category_memory" ADD CONSTRAINT "merchant_category_memory_owner_id_category_id_categories_owner_id_id_fk" FOREIGN KEY ("owner_id","category_id") REFERENCES "public"."categories"("owner_id","id") ON DELETE no action ON UPDATE no action;