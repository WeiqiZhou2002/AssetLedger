-- Refuse to retire data that appeared after the earlier cleanup migration.
-- Hold every checked relation until the migration transaction commits.
DO $$
BEGIN
  LOCK TABLE "reconciliation_runs", "reconciliation_notes", "legacy_imports",
    "legacy_mappings", "legacy_points_valuations", "loyalty_observations",
    "balance_snapshots" IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM "reconciliation_runs") THEN
    RAISE EXCEPTION 'Retired data guard: reconciliation_runs is not empty';
  END IF;
  IF EXISTS (SELECT 1 FROM "reconciliation_notes") THEN
    RAISE EXCEPTION 'Retired data guard: reconciliation_notes is not empty';
  END IF;
  IF EXISTS (SELECT 1 FROM "legacy_imports") THEN
    RAISE EXCEPTION 'Retired data guard: legacy_imports is not empty';
  END IF;
  IF EXISTS (SELECT 1 FROM "legacy_mappings") THEN
    RAISE EXCEPTION 'Retired data guard: legacy_mappings is not empty';
  END IF;
  IF EXISTS (SELECT 1 FROM "legacy_points_valuations") THEN
    RAISE EXCEPTION 'Retired data guard: legacy_points_valuations is not empty';
  END IF;
  IF EXISTS (SELECT 1 FROM "loyalty_observations" WHERE "legacy_valuation_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'Retired data guard: loyalty_observations.legacy_valuation_id is not null';
  END IF;
  IF EXISTS (SELECT 1 FROM "balance_snapshots" WHERE "legacy_import_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'Retired data guard: balance_snapshots.legacy_import_id is not null';
  END IF;
  IF EXISTS (SELECT 1 FROM "balance_snapshots" WHERE "legacy_sheet_name" IS NOT NULL) THEN
    RAISE EXCEPTION 'Retired data guard: balance_snapshots.legacy_sheet_name is not null';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "balance_snapshots" DROP CONSTRAINT "balance_snapshots_owner_id_legacy_import_id_legacy_imports_owner_id_id_fk";--> statement-breakpoint
ALTER TABLE "loyalty_observations" DROP CONSTRAINT "loyalty_observations_owner_id_legacy_valuation_id_legacy_points_valuations_owner_id_id_fk";--> statement-breakpoint
ALTER TABLE "legacy_imports" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legacy_mappings" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legacy_points_valuations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reconciliation_notes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "legacy_imports";--> statement-breakpoint
DROP TABLE "legacy_mappings";--> statement-breakpoint
DROP TABLE "legacy_points_valuations";--> statement-breakpoint
DROP TABLE "reconciliation_notes";--> statement-breakpoint
DROP TABLE "reconciliation_runs";--> statement-breakpoint
ALTER TABLE "balance_snapshots" DROP CONSTRAINT "balance_snapshots_legacy_unique";--> statement-breakpoint
DROP INDEX "loyalty_observations_legacy_unique";--> statement-breakpoint
ALTER TABLE "balance_snapshots" DROP COLUMN "legacy_import_id";--> statement-breakpoint
ALTER TABLE "balance_snapshots" DROP COLUMN "legacy_sheet_name";--> statement-breakpoint
ALTER TABLE "loyalty_observations" DROP COLUMN "legacy_valuation_id";--> statement-breakpoint
DROP TYPE "public"."legacy_status";--> statement-breakpoint
DROP TYPE "public"."reconciliation_scope";--> statement-breakpoint
DROP TYPE "public"."review_status";
