# AGENTS.md — Asset Ledger

Single-owner, self-hosted personal finance application with a Simplified Chinese UI.

## Sources of truth

1. [docs/decisions.md](docs/decisions.md) — current product and engineering decisions. **Wins on conflict.**
2. This file — engineering conventions for every change.

Read the relevant implementation before changing behavior. Keep decisions and implementation consistent;
do not silently revive removed product workflows.

## Hard rules

- Never commit real financial data, credentials, statements, screenshots or examples calibrated to real
  records. Seeds and fixtures must be synthetic and use fictional institutions and accounts.
- `Asset.xlsx` and `samples/` must stay gitignored. Tools must never open, list, read, copy, move, rename,
  write or parse them. Generate synthetic test documents in code instead.
- Money is never a JS `number` in domain calculations. Use `decimal.js` through `lib/money`, decimal
  strings at input and transport boundaries, and Postgres `NUMERIC(20,4)` for money. Points use `BIGINT`.
  Conversion to chart coordinates is allowed only at the presentation boundary.
- Every table has a UUID `id`, `created_at` and `updated_at`. Every owned table has `owner_id`;
  queries and joins enforce the session user's ownership, never a client-supplied owner ID.
- Confirmed monetary entries use void plus replacement (`replaces_entry_id`) and an audit record.
  Non-monetary metadata changes also require audit. Explicit data-reset and delete-all services are
  separate, scoped operations with their own preview, confirmation and locking requirements.
- Logs must not contain statement text, merchant-associated amounts, passwords, TOTP secrets, session
  tokens, provider tokens, full card numbers, expiry, CVV or CID. Log IDs, hashes and error kinds only.
  Audit payloads follow their existing allowlists; do not weaken the shared redaction layer.
- Uploaded files live under private `DATA_DIR`, never under `public/`; preview and download require
  owner authentication. Keep secrets out of client bundles and server-rendered page payloads.
- AI parsing stays off unless `AI_PARSING_ENABLED=true`, a provider key is configured, and the owner
  confirms each statement after seeing exactly what will be sent. Consent is bound to the preview hash.
- Preserve purpose-separated encryption and step-up verification for card reveal. Never put decrypted
  card fields in logs, audit details, URLs, persistent browser storage or ordinary data exports.

## Layout

```text
apps/web/                  Next.js App Router, strict TypeScript, Tailwind, shadcn/ui, Drizzle, Vitest
  app/(auth)/              login and TOTP
  app/(app)/               dashboard, activity, accounts, benefits, statements, investments, rewards, settings
  app/api/                 authenticated route handlers
  lib/money/               Decimal helpers, formatting and FX conversion
  lib/ledger/              entries, postings, accounts, balance updates and purchase groups
  lib/snapshots/           internal observations, versions and frozen FX; no snapshot management UI
  lib/bank-sync/           Plaid sync, matching, transfer memory, backfill and reset
  lib/imports/             file imports, mapping, deduplication, review and approval
  lib/benefits/            refund-based card benefits and credit-type grouping
  lib/rewards/             programs, owner-managed accounts, points events and CPP
  lib/auth/                sessions, encryption, TOTP, rate limits and origin checks
  db/                      schema and generated SQL migrations
  worker/                  import jobs, sync scheduling and retention cleanup
  tests/                   Vitest unit/integration tests with PGlite and synthetic fixtures
services/statement-parser/ FastAPI, PyMuPDF, Tesseract and pytest, managed with uv
fixtures/                  synthetic fixtures only
scripts/                  backup, restore and administration helpers
docs/decisions.md          current product and engineering decisions
```

## Domain invariants

- Signed postings: debit positive, credit negative. Each confirmed entry balances to zero per currency;
  cross-currency entries use a separate `fx_clearing` account for each currency.
- Account ledger balances sum confirmed postings. Liabilities carry negative balances; preserve
  overdraft and overpayment signs rather than clamping them to zero.
- Account types mirror `lib/ledger/constants.ts`, imported by `db/schema.ts`:
  `asset_cash`, `asset_brokerage_cash`, `asset_security`, `asset_receivable`, `asset_prepaid`,
  `liability_credit_card`, `liability_loan`, `income`, `expense`, `equity_opening`, `fx_clearing`,
  `transfer_clearing`, `reconciliation_adjustment`. The last six are system types, including compatibility
  types; their existence does not authorize removed workflows.
- Current overview: assets, liabilities and net worth across all currencies, plus current-month income
  and spending. Net worth is assets minus liabilities. Receivables and prepaid assets follow
  `financial_inclusion`; cash-like scope flags do not replace this overview definition.
- Prefer each account's latest published balance observation. Without one, only non-security accounts
  with an existing confirmed opening may fall back to ledger balances. Securities require market value.
  Exclude and identify missing balances or FX; never guess member balances from an aggregate group.
- FX rates are quote-currency units per one base-currency unit; native-to-base conversion divides by
  the rate. Observation FX is frozen. Staleness is relative to the as-of date and configured threshold.
- Spending is net expense postings after refunds. Transfers, card payments, investment principal,
  loans and asset prepayments do not count as spending. Income follows income postings.
- Purchase groups are display aggregates, not new postings; their confirmed totals must be evaluated
  from linked confirmed expenses, not hard-coded results.
- Plaid and manual balance observations create no entries. There is no opening-balance UI workflow;
  existing explicit openings and compatibility services remain valid.
- Manual updates require an active real account with no enabled Plaid mapping, including security
  mappings. Reject future owner-local dates and block publication when required FX is missing.
- Manual reminder days default to 7; NULL means off. Due means no observation or an observation strictly
  older than today minus the configured days. Plaid scheduling remains independent.
- Matched bank transfer legs retain separate dates and evidence, balance through `transfer_clearing`,
  and share a match. Unmatched automatic transactions follow income/expense/refund fallback rules.
- Restore owner transfer choices before heuristics using stable provider/lineage keys. Keep pair-type
  validation and upstream review protection. Explicit unmatch clears memory; reset/reimport preserves it.
  Transfer audit records contain entity IDs, never provider keys or transaction descriptions.
- Benefit credits are refunds with a benefit family. Use the first available configured expense category
  or 其他支出. Never search for or create purchase links; keep historical links without displaying them.
  Merchant Offers are ordinary refunds, excluded from benefits and protected from transfer matching.
- Rewards accounts are owner-managed; CPP valuation never enters net worth or spending.
- Snapshots UI, reconciliation and Excel migration are removed product features. Internal observations
  and compatibility types must not be used to reintroduce their UI or APIs.

## Implementation and verification

- TypeScript is strict; no `any` in domain code. Keep modules small and business calculations pure.
- Domain services accept a database handle so tests can use PGlite. Keep route handlers and actions thin.
- Use transactions and existing owner/import/rewards locks when changing related records. Preserve
  idempotency, owner isolation, provider evidence and replacement chains.
- UI copy is Simplified Chinese; official account, currency and program names retain their spelling.
- Tests must compute business results through real engine inputs; hard-coded totals belong only in
  expectations over synthetic data. Never derive fixtures from the owner's records.
- Generate schema migrations, review their SQL and format generated JSON. Destructive retirement
  migrations must guard against unexpected existing data and test both success and refusal paths.
- Preserve CLI, build, Docker and worker entry points when removing apparently unused code.

## Commands

- `pnpm install` — install the workspace dependencies.
- `pnpm -C apps/web exec vitest run` — unit and PGlite integration tests, without Docker.
- `pnpm -C apps/web typecheck`, `pnpm -C apps/web lint`, `pnpm -C apps/web build`.
- `pnpm -C apps/web format:check` — code formatting; check changed Markdown with Prettier separately.
- `pnpm -C apps/web db:generate` / `db:migrate` / `db:seed`.
- `cd services/statement-parser && uv run pytest` — synthetic parser tests.
- `docker compose up --build -d` — self-hosted database, parser, web and worker.

Run checks appropriate to the change. Do not operate on real owner data to validate code changes.
