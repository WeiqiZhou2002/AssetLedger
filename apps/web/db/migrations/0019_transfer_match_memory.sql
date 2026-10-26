CREATE TABLE "transfer_account_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leg_key" text NOT NULL,
	"account_id" uuid NOT NULL,
	CONSTRAINT "transfer_account_assignments_owner_leg_unique" UNIQUE("owner_id","leg_key")
);
--> statement-breakpoint
CREATE TABLE "transfer_pair_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_key" text NOT NULL,
	"right_key" text NOT NULL,
	CONSTRAINT "transfer_pair_confirmations_owner_pair_unique" UNIQUE("owner_id","left_key","right_key")
);
--> statement-breakpoint
ALTER TABLE "transfer_account_assignments" ADD CONSTRAINT "transfer_account_assignments_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_account_assignments" ADD CONSTRAINT "transfer_account_assignments_owner_id_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_pair_confirmations" ADD CONSTRAINT "transfer_pair_confirmations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;