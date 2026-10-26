ALTER TABLE "accounts" ADD COLUMN "balance_reminder_days" integer;
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_balance_reminder_days_check" CHECK ("accounts"."balance_reminder_days" IS NULL OR "accounts"."balance_reminder_days" IN (1, 3, 7, 14, 30));
--> statement-breakpoint
UPDATE "accounts" AS a
SET "balance_reminder_days" = 7
WHERE a."is_active" AND NOT a."is_system"
  AND a."type" IN ('asset_cash', 'asset_brokerage_cash', 'asset_security', 'asset_receivable', 'asset_prepaid', 'liability_credit_card', 'liability_loan')
  AND NOT EXISTS (
    SELECT 1 FROM "bank_connection_accounts" AS mapping
    WHERE mapping."owner_id" = a."owner_id" AND mapping."is_enabled"
      AND (mapping."account_id" = a."id" OR mapping."security_account_id" = a."id")
  );
--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "balance_reminder_days" SET DEFAULT 7;
