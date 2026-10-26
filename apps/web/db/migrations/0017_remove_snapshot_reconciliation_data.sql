-- Owner-approved one-time removal of retired product data. Internal Plaid observations survive.
DELETE FROM "reconciliation_notes";
--> statement-breakpoint
DELETE FROM "reconciliation_runs";
--> statement-breakpoint
UPDATE "loyalty_observations"
SET "legacy_valuation_id" = NULL
WHERE "legacy_valuation_id" IN (SELECT "id" FROM "legacy_points_valuations");
--> statement-breakpoint
DELETE FROM "legacy_points_valuations";
--> statement-breakpoint
DELETE FROM "snapshot_fx"
WHERE "snapshot_id" IN (SELECT "id" FROM "balance_snapshots" WHERE "source" <> 'plaid');
--> statement-breakpoint
DELETE FROM "snapshot_items"
WHERE "snapshot_id" IN (SELECT "id" FROM "balance_snapshots" WHERE "source" <> 'plaid');
--> statement-breakpoint
DELETE FROM "balance_snapshots" WHERE "source" <> 'plaid';
--> statement-breakpoint
DELETE FROM "legacy_mappings";
--> statement-breakpoint
DELETE FROM "legacy_imports";
