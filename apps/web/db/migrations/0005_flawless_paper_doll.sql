ALTER TABLE "legacy_points_valuations" ADD CONSTRAINT "legacy_points_owner_id_unique" UNIQUE("owner_id","id");--> statement-breakpoint
CREATE TYPE "public"."loyalty_event_type" AS ENUM('earn', 'bonus', 'redeem', 'transfer_out', 'transfer_in', 'refund', 'expire', 'purchase', 'adjust');--> statement-breakpoint
CREATE TYPE "public"."loyalty_program_kind" AS ENUM('bank_points', 'airline', 'hotel', 'cashback', 'other');--> statement-breakpoint
CREATE TYPE "public"."loyalty_source" AS ENUM('manual', 'statement', 'legacy');--> statement-breakpoint
CREATE TABLE "loyalty_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"program_id" uuid NOT NULL,
	"name" text NOT NULL,
	"member_last4" char(4),
	"linked_card_account_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	CONSTRAINT "loyalty_accounts_owner_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "loyalty_accounts_name_unique" UNIQUE("owner_id","program_id","name"),
	CONSTRAINT "loyalty_accounts_last4_check" CHECK ("loyalty_accounts"."member_last4" IS NULL OR "loyalty_accounts"."member_last4" ~ '^[A-Za-z0-9]{4}$')
);
--> statement-breakpoint
CREATE TABLE "loyalty_cpp_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"program_id" uuid NOT NULL,
	"effective_date" date NOT NULL,
	"cpp_baseline" numeric(10, 4) NOT NULL,
	"cpp_personal" numeric(10, 4) NOT NULL,
	"source" text NOT NULL,
	"note" text,
	CONSTRAINT "loyalty_cpp_program_date_unique" UNIQUE("owner_id","program_id","effective_date"),
	CONSTRAINT "loyalty_cpp_nonnegative_check" CHECK ("loyalty_cpp_history"."cpp_baseline" >= 0 AND "loyalty_cpp_history"."cpp_personal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "loyalty_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"loyalty_account_id" uuid NOT NULL,
	"event_date" date NOT NULL,
	"points_delta" bigint NOT NULL,
	"type" "loyalty_event_type" NOT NULL,
	"transfer_id" uuid,
	"related_journal_entry_id" uuid,
	"statement_id" uuid,
	"source" "loyalty_source" DEFAULT 'manual' NOT NULL,
	"external_reference" text,
	"note" text,
	CONSTRAINT "loyalty_events_owner_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "loyalty_events_nonzero_check" CHECK ("loyalty_events"."points_delta" <> 0),
	CONSTRAINT "loyalty_events_sign_check" CHECK (("loyalty_events"."type" IN ('redeem','expire','transfer_out') AND "loyalty_events"."points_delta" < 0) OR ("loyalty_events"."type" IN ('earn','bonus','refund','purchase','transfer_in') AND "loyalty_events"."points_delta" > 0) OR "loyalty_events"."type" = 'adjust'),
	CONSTRAINT "loyalty_events_transfer_check" CHECK (("loyalty_events"."type" IN ('transfer_out','transfer_in')) = ("loyalty_events"."transfer_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "loyalty_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"loyalty_account_id" uuid NOT NULL,
	"observed_on" date NOT NULL,
	"balance" bigint NOT NULL,
	"source" "loyalty_source" DEFAULT 'manual' NOT NULL,
	"statement_id" uuid,
	"legacy_valuation_id" uuid,
	CONSTRAINT "loyalty_observations_account_date_unique" UNIQUE("owner_id","loyalty_account_id","observed_on")
);
--> statement-breakpoint
CREATE TABLE "loyalty_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" "loyalty_program_kind" NOT NULL,
	"unit_label" text DEFAULT '点' NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	CONSTRAINT "loyalty_programs_owner_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "loyalty_programs_code_unique" UNIQUE("owner_id","code")
);
--> statement-breakpoint
CREATE TABLE "loyalty_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_event_id" uuid NOT NULL,
	"to_event_id" uuid NOT NULL,
	"ratio_from" bigint NOT NULL,
	"ratio_to" bigint NOT NULL,
	"note" text,
	CONSTRAINT "loyalty_transfers_from_unique" UNIQUE("owner_id","from_event_id"),
	CONSTRAINT "loyalty_transfers_to_unique" UNIQUE("owner_id","to_event_id"),
	CONSTRAINT "loyalty_transfers_ratio_check" CHECK ("loyalty_transfers"."ratio_from" > 0 AND "loyalty_transfers"."ratio_to" > 0 AND "loyalty_transfers"."from_event_id" <> "loyalty_transfers"."to_event_id")
);
--> statement-breakpoint
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_owner_id_program_id_loyalty_programs_owner_id_id_fk" FOREIGN KEY ("owner_id","program_id") REFERENCES "public"."loyalty_programs"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_owner_id_linked_card_account_id_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","linked_card_account_id") REFERENCES "public"."accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_cpp_history" ADD CONSTRAINT "loyalty_cpp_history_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_cpp_history" ADD CONSTRAINT "loyalty_cpp_history_owner_id_program_id_loyalty_programs_owner_id_id_fk" FOREIGN KEY ("owner_id","program_id") REFERENCES "public"."loyalty_programs"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_events" ADD CONSTRAINT "loyalty_events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_events" ADD CONSTRAINT "loyalty_events_owner_id_loyalty_account_id_loyalty_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","loyalty_account_id") REFERENCES "public"."loyalty_accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_events" ADD CONSTRAINT "loyalty_events_owner_id_related_journal_entry_id_journal_entries_owner_id_id_fk" FOREIGN KEY ("owner_id","related_journal_entry_id") REFERENCES "public"."journal_entries"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_events" ADD CONSTRAINT "loyalty_events_owner_id_statement_id_statements_owner_id_id_fk" FOREIGN KEY ("owner_id","statement_id") REFERENCES "public"."statements"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_observations" ADD CONSTRAINT "loyalty_observations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_observations" ADD CONSTRAINT "loyalty_observations_owner_id_loyalty_account_id_loyalty_accounts_owner_id_id_fk" FOREIGN KEY ("owner_id","loyalty_account_id") REFERENCES "public"."loyalty_accounts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_observations" ADD CONSTRAINT "loyalty_observations_owner_id_statement_id_statements_owner_id_id_fk" FOREIGN KEY ("owner_id","statement_id") REFERENCES "public"."statements"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_observations" ADD CONSTRAINT "loyalty_observations_owner_id_legacy_valuation_id_legacy_points_valuations_owner_id_id_fk" FOREIGN KEY ("owner_id","legacy_valuation_id") REFERENCES "public"."legacy_points_valuations"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD CONSTRAINT "loyalty_programs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transfers" ADD CONSTRAINT "loyalty_transfers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transfers" ADD CONSTRAINT "loyalty_transfers_owner_id_from_event_id_loyalty_events_owner_id_id_fk" FOREIGN KEY ("owner_id","from_event_id") REFERENCES "public"."loyalty_events"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transfers" ADD CONSTRAINT "loyalty_transfers_owner_id_to_event_id_loyalty_events_owner_id_id_fk" FOREIGN KEY ("owner_id","to_event_id") REFERENCES "public"."loyalty_events"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_events_statement_unique" ON "loyalty_events" USING btree ("owner_id","statement_id") WHERE "loyalty_events"."source" = 'statement';--> statement-breakpoint
CREATE INDEX "loyalty_events_account_date_idx" ON "loyalty_events" USING btree ("owner_id","loyalty_account_id","event_date");--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_observations_statement_unique" ON "loyalty_observations" USING btree ("owner_id","statement_id") WHERE "loyalty_observations"."source" = 'statement';--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_observations_legacy_unique" ON "loyalty_observations" USING btree ("owner_id","legacy_valuation_id","loyalty_account_id") WHERE "loyalty_observations"."legacy_valuation_id" IS NOT NULL;--> statement-breakpoint
