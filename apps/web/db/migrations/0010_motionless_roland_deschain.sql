CREATE TABLE "bank_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"connection_id" uuid NOT NULL,
	"job_id" uuid,
	"kind" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"effective_from_date" date NOT NULL,
	"update_status" text,
	"counts" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_connection_accounts" ADD COLUMN "import_from_date" date;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD COLUMN "sync_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD COLUMN "backfill_plan" jsonb;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "sync_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "sync_run_id" uuid;--> statement-breakpoint
ALTER TABLE "bank_sync_runs" ADD CONSTRAINT "bank_sync_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_sync_runs" ADD CONSTRAINT "bank_sync_runs_owner_id_connection_id_bank_connections_owner_id_id_fk" FOREIGN KEY ("owner_id","connection_id") REFERENCES "public"."bank_connections"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_sync_runs_latest_idx" ON "bank_sync_runs" USING btree ("owner_id","connection_id","started_at");