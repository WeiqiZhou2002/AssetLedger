CREATE TABLE "transfer_pair_rejections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_key" text NOT NULL,
	"right_key" text NOT NULL,
	CONSTRAINT "transfer_pair_rejections_owner_pair_unique" UNIQUE("owner_id","left_key","right_key")
);
--> statement-breakpoint
ALTER TABLE "transfer_pair_rejections" ADD CONSTRAINT "transfer_pair_rejections_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;