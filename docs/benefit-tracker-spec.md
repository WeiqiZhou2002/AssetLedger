# Card benefit progress tracker — design spec

Status: draft for owner review. Nothing here is implemented, and §9 changes a current decision only after
approval.

This spec describes how a credit card benefit (statement credit) progress tracker works, so that Asset
Ledger (TypeScript) and Sure (Ruby) can each implement it from shared data and shared test vectors, not
shared code. It covers:

- a language-neutral benefit catalog and where to host it (§3);
- how detected credits map to catalog credits (§4);
- period and progress math (§5);
- synthetic test vectors both implementations must pass (§6);
- an Asset Ledger implementation outline (§7) and a Sure storage sketch (§8);
- the proposed change to [decisions.md](decisions.md) §卡权益 (§9);
- open questions (§10).

Companion files, all in [benefit-tracker/](benefit-tracker/):

| File                                                                 | Contents                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [catalog.sample.json](benefit-tracker/catalog.sample.json)           | Seed catalog for three real cards, cited, with to-verify markers    |
| [test-vectors.json](benefit-tracker/test-vectors.json)               | 23 synthetic vectors (fictional issuer, products and keywords)      |
| [sure-discussion-draft.md](benefit-tracker/sure-discussion-draft.md) | English draft of a Discussion post for we-promise/sure (not posted) |

## 1. Context

### 1.1 Asset Ledger today

- Detection: [config.ts](../apps/web/lib/benefits/config.ts) `detectBenefit` flags positive inflows on
  `liability_credit_card` accounts using ordered keyword families (`travel`, `dining`, `rideshare`, `airline`,
  `hotel`, `entertainment`, `shopping`, `travel-program`, `fitness`, `wireless`, then `generic`). Payment
  words and merchant Offers block detection.
- Recording: [service.ts](../apps/web/lib/benefits/service.ts) marks the entry as a refund with
  `benefit_credit = true` and a `benefit_family`. Benefits reduce spending and never count as income.
- Display: [queries.ts](../apps/web/lib/benefits/queries.ts) groups confirmed benefit refunds by card, by
  calendar year, and by a short name from [credit-name.ts](../apps/web/lib/benefits/credit-name.ts)
  `normalizedCreditName` (issuer, product, digits and references stripped; otherwise 其他权益). There is a
  rolling 12-month total.
- What it cannot say: how much of each credit is left in the current month, quarter, half or card year,
  because nothing knows a card's credits, their caps or their reset rules. The current decision keeps
  identification keyword-only with no per-card catalog; this spec proposes adding one (§9).

### 1.2 Sure today

- A card is an `Account` with a `CreditCard` accountable (`statement_close_day`, `due_day`, `annual_fee`,
  `available_credit`, `minimum_payment`, `expiration_date`). There is no account-open date.
- Entries use the opposite sign to Asset Ledger: a negative `entries.amount` is an inflow, so a statement
  credit is a negative entry on the card account.
- Transactions carry `kind`, `category_id`, `merchant_id`, tags and an `extra` jsonb column. A rules
  engine (`Rule::ConditionFilter::*`, `Rule::ActionExecutor::*`) already matches transaction names.
- There is no benefit concept today.

### 1.3 Why share data and tests instead of code

The two stacks share nothing at runtime, and both are AGPL. What they can share without coupling is the
facts (issuer terms) and the expected behaviour. A data repository plus executable vectors lets each
project write idiomatic code, keeps catalog fixes in one place, and makes divergence visible in CI.

## 2. Goals and non-goals

Goals:

- Per card and per catalog credit: cap, used, remaining and state for each period, plus a benefit-year
  summary (used, expired unused, available now, upcoming).
- Calendar-year, card-anniversary and statement-anniversary resets; monthly, quarterly, semiannual,
  annual and multi-year credits; dated benefit refreshes.
- Owner control: choose the card product, override a cap, stop tracking a credit, assign a credit to a
  catalog entry or period by hand.
- Unmatched credits keep today's behaviour (grouped by short name, 其他权益 as the fallback).

Non-goals:

- Linking a credit to the purchase that earned it (Asset Ledger's decisions forbid searching for or
  creating purchase links).
- Changing how credits are detected or recorded. Progress is a read-only view over existing refunds.
- Credits that never post to the card (Uber Cash, in-app Lyft credits, DoorDash promos). The catalog
  records them with a non-statement `delivery` so the UI can explain why they are absent.
- Tracking enrollment or activation state, spend-unlocked benefits, or conditional unlocks.
- Valuing benefits in net worth, income or rewards (CPP).
- Fetching issuer pages at runtime. Self-hosted instances work offline with a pinned catalog.

## 3. Shared catalog

### 3.1 Hosting and licensing

The catalog is hosted in [CardFacts](https://github.com/WeiqiZhou2002/cardfacts), a public repository that
both projects vendor at a pinned release. CardFacts also covers annual fees and earn rates for personal and
business cards; this spec uses only its credits.

- Data under CC0-1.0. Benefit amounts and dates are facts; CC0 lets either AGPL project, and anyone else,
  ship the file without attribution plumbing in the UI. Tooling (schema, validator) under MIT.
- Layout (per the CardFacts proposal): `schema/card.schema.json` (JSON Schema 2020-12),
  `data/us/<issuer>/<product-id>.json`, a build step that writes `dist/cards.json` plus a SHA-256,
  `vectors/credit-progress.json`, and `CONTRIBUTING.md` with the citation rules in §3.4.
- Release: date-based `catalog_version` (for example `2026.10.27`). Consumers copy `dist/cards.json`
  and record version and hash; updating is an ordinary pull request in each project, never a runtime
  download.
- CI in CardFacts: schema validation, the invariants listed in §3.3, link check, and a reminder
  for versions whose `last_verified` is older than 180 days.

JSON rather than YAML: both languages parse it with the standard library, JSON Schema validates it, and
decimal strings survive unchanged.

The canonical draft catalog, the rules in §4–§6 and the vectors now live in CardFacts; the copies in
[benefit-tracker/](benefit-tracker/) are kept for reviewing this spec.

### 3.2 Shape

```json
{
  "schema_version": 1,
  "catalog_version": "2026.10.27",
  "license": "CC0-1.0",
  "products": [
    {
      "id": "us-chase-sapphire-reserve",
      "issuer": "Chase",
      "name": "Sapphire Reserve",
      "country": "US",
      "currency": "USD",
      "aliases": ["SAPPHIRE RESERVE"],
      "sources": [{ "id": "chase-csr-page", "url": "https://…", "title": "…", "accessed": "2026-10-27" }],
      "credits": [
        {
          "id": "dining",
          "name": "Dining Credit",
          "family": "dining",
          "delivery": "statement_credit",
          "enrollment": "none",
          "match": { "keywords": ["DINING CREDIT", "EXCLUSIVE TABLES"] },
          "versions": [
            {
              "effective_from": null,
              "effective_to": null,
              "status": "verified",
              "amount": "150.00",
              "period": "semiannual",
              "reset_basis": "calendar",
              "period_boundaries": "stated",
              "max_posting_lag_days": null,
              "source": "chase-csr-page",
              "last_verified": "2026-10-27",
              "notes": "Up to $150 January–June and $150 July–December."
            }
          ]
        }
      ]
    }
  ]
}
```

### 3.3 Field reference

Product:

| Field      | Type       | Meaning                                                                           |
| ---------- | ---------- | --------------------------------------------------------------------------------- |
| `id`       | string     | Stable slug, `<country>-<issuer>-<product>`. Never reused for another product.    |
| `issuer`   | string     | Official issuer name.                                                             |
| `name`     | string     | Official product name, without trademark symbols.                                 |
| `country`  | ISO 3166-1 | Market whose terms are catalogued.                                                |
| `currency` | ISO 4217   | Currency of every `amount` in the product.                                        |
| `aliases`  | string[]   | Uppercase phrases used only to suggest a product for an account, never to assign. |
| `sources`  | object[]   | `{ id, url, title, accessed }`, referenced by versions.                           |
| `notes`    | string     | Free text for reviewers.                                                          |
| `credits`  | object[]   | Ordered as the UI should list them.                                               |

Credit:

| Field        | Type     | Meaning                                                                                                    |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------------- |
| `id`         | string   | Stable slug, unique within the product. Owner choices reference `product id + credit id`.                  |
| `name`       | string   | Official credit name in the issuer's language.                                                             |
| `family`     | string?  | Optional hint matching Asset Ledger's `BenefitFamily`; used only by the fallback in §4.3. Sure ignores it. |
| `delivery`   | enum     | `statement_credit` (trackable), `issuer_wallet` (e.g. Uber Cash) or `in_app` (merchant-side promos).       |
| `enrollment` | enum     | `required`, `activation`, `none` or `unknown`. Informational in v1.                                        |
| `match`      | object   | `{ keywords: string[], exclude?: string[] }`, see §4.4.                                                    |
| `versions`   | object[] | Terms over time, non-overlapping, ordered by `effective_from`.                                             |

Version:

| Field                  | Type            | Meaning                                                                                                    |
| ---------------------- | --------------- | ---------------------------------------------------------------------------------------------------------- |
| `effective_from`       | date \| null    | First day these terms apply. `null` means not stated by a cited source; see §5.3.                          |
| `effective_to`         | date \| null    | Last day these terms apply (inclusive); `null` means open-ended.                                           |
| `status`               | enum            | `verified` (amount cited), `to_verify` (no progress computed), `synthetic` (test vectors only).            |
| `amount`               | decimal string  | Cap per period in the product currency. `null` exactly when `status` is `to_verify`.                       |
| `period`               | enum            | `monthly`, `quarterly`, `semiannual`, `annual` or `multi_year`.                                            |
| `period_years`         | integer         | Only with `multi_year`, e.g. `4`.                                                                          |
| `reset_basis`          | enum            | `calendar`, `anniversary`, `anniversary_statement` (annual only) or `since_last_credit` (multi-year only). |
| `period_boundaries`    | enum            | `stated` when the source names the boundaries, `inferred` when only the cadence is stated.                 |
| `cap_excludes_tax`     | boolean         | Default `false`. `true` when terms say "plus applicable taxes"; enables the tolerance in §5.4.             |
| `per_transaction_cap`  | decimal string? | Informational (e.g. $250 per stay). Progress uses `amount` only.                                           |
| `max_posting_lag_days` | integer \| null | Longest delay the issuer states between purchase and credit; `null` when not stated (treated as 0).        |
| `source`               | string          | A product `sources[].id`.                                                                                  |
| `last_verified`        | date            | When a person last checked the amount and period against the source.                                       |
| `notes`                | string          | Paraphrase of the relevant terms. Never paste issuer text at length.                                       |

Invariants checked in CI: unique ids; `source` resolves; `amount` is `null` exactly for `to_verify`;
`multi_year` pairs with `since_last_credit` and nothing else does; `anniversary_statement` only with
`annual`; versions of a credit do not overlap; keywords are non-empty after normalization (§4.4) for
`statement_credit` credits.

### 3.4 Verification rules

- Every non-null `amount` cites a public issuer page or benefits guide in `source`, with `last_verified`.
  Third-party blogs can point to a change but are never the cited source.
- Unknown values stay `null` with `status: "to_verify"`; contributors never fill amounts from memory.
- Keywords are matching heuristics, not issuer terms. They must not be copied from anyone's real
  statement; use brand or program names.
- A benefit refresh adds a new version (closing the old one with `effective_to`) instead of editing the
  old amount, so history keeps computing correctly.

### 3.5 Seed content

[catalog.sample.json](benefit-tracker/catalog.sample.json) was checked against issuer pages on
2026-10-27:

| Product                        | Verified                                                                                                                                                                                                                                                                   | To verify                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| American Express Platinum Card | Hotel $300 semiannual; Resy $100 quarterly; Digital Entertainment $25 monthly; lululemon $75 quarterly; Walmart+ $12.95 monthly plus tax; Uber One $120, Airline Fee $200, CLEAR+ $219, Oura $200 per calendar year; Uber Cash (wallet, not trackable)                     | `effective_from` of current terms; Equinox and Airbnb Experiences (in the terms page, absent from the product page) |
| Chase Sapphire Reserve         | Travel $300 per statement-anniversary year; The Edit $500 per calendar year from 2026-01-01 ($250 per stay); Dining $150 and StubHub $150 semiannual; Peloton $10 monthly to 2027-12-31; trusted-traveler $120 every four years; Lyft and DoorDash (in-app, not trackable) | `effective_from` of the 2025 refresh; The Edit terms before 2026                                                    |
| Capital One Venture X          | —                                                                                                                                                                                                                                                                          | Travel credit amount and reset basis; trusted-traveler amount (the rendered page did not show them)                 |

Facts from the sources that shaped §5: Amex assigns a credit to the benefit period of the purchase's
processing date and says credits can take up to 8 weeks (90 days for the hotel credit); Chase says credits
post within 3 business days but may take up to 4 weeks, and defines the travel-credit year as running to
the first statement date after the account-open anniversary.

## 4. Mapping detected credits to catalog credits

### 4.1 Inputs

Each project first decides which entries are benefit credits; the catalog only maps them.

- Asset Ledger: confirmed `refund` entries on `liability_credit_card` with `benefit_credit = true`,
  excluding Offers, exactly the rows `benefitRecords` in [queries.ts](../apps/web/lib/benefits/queries.ts)
  already loads. Detection stays in `detectBenefit` and its rescans.
- Sure: inflow entries (negative `amount`) of `kind = standard`, not part of a transfer, on a `CreditCard`
  account that has a catalog product, whose text matches a keyword of that product (§8).

A credit entry, for mapping and progress, is `{ id, date, amount, currency, description, merchant, family? }`
where `amount` is a positive decimal string (Sure negates its entry amount) and `date` is the entry's
booking date: Asset Ledger `posted_date ?? event_date`, as `benefitOverview` uses today; Sure
`entries.date`.

### 4.2 Card product

An account is tracked only after the owner selects a catalog product for it. `aliases`, matched with the
§4.4 rules against institution plus account name, may pre-select a suggestion in the form; the suggestion
is never saved without the owner's confirmation.

### 4.3 Matching order

For one entry on an account with product `P`:

1. No product → unmatched, reason `no_product`.
2. Entry currency differs from `P.currency` → unmatched, `currency_mismatch` (no FX conversion).
3. Owner assignment exists:
   - explicit none → unmatched, `owner_none`;
   - a credit id → that credit, provided some version is effective at the entry date (or at the assigned
     period start), otherwise `no_effective_version`.
4. Keywords, over `P`'s `statement_credit` credits:
   - skip a credit whose `exclude` keywords hit;
   - a credit is a candidate when a keyword hits and some version is effective at the entry date, where
     "effective" extends `effective_to` by `max_posting_lag_days` so a late credit for an ended benefit
     still maps;
   - the candidate with the longest hitting keyword (Unicode code points) wins; a tie at the top length
     → unmatched, `ambiguous`;
   - keywords that hit only out-of-effect credits → `no_effective_version`.
5. Family fallback (Asset Ledger only): when the entry's `benefit_family` equals the `family` of exactly
   one effective credit, choose it; more than one → `ambiguous`.
6. Otherwise unmatched, `no_match`.
7. If the chosen credit is disabled by the owner for this account → unmatched, `credit_disabled`.

Unmatched entries keep today's display: grouped by `normalizedCreditName`, falling back to 其他权益. The
reason is for diagnostics and tests; the UI shows only the special cases in §7.4.

Matching is computed at read time. Only owner choices are stored, so catalog updates apply immediately
and no rescan or `BENEFIT_VERSION` bump is needed.

### 4.4 Keyword normalization

Both implementations must normalize identically; no regular-expression dialect is involved in matching:

1. `text = (description ?? "") + " " + (merchant ?? "")`.
2. Unicode NFKC, then Unicode default uppercase (`toUpperCase` / `String#upcase`).
3. Replace each run of characters that are not letters (`\p{L}`), digits (`\p{N}`), `+` or `&` with one
   space; trim.
4. Wrap in single spaces. A keyword, normalized by steps 2–3, hits when `" " + keyword + " "` occurs in
   the wrapped text.

So `FLIX` matches `flix credit` and `ＦＬＩＸ ＣＲＥＤＩＴ` (full-width) but not `FLIXPREMIUM`, and `FLIX PREMIUM`
matches `FLIX-PREMIUM*CREDIT`.

### 4.5 Reusing Asset Ledger's rules

- `detectBenefit`, its family order, payment guards and Offer exclusion stay the gate. The catalog never
  turns a non-benefit into a benefit.
- Catalog keywords start from the existing patterns: `RESY` from `dining`, `DIGITAL ENTERTAINMENT` from
  `entertainment`, `WALMART+` from `shopping`, `CLEAR`, `GLOBAL ENTRY`, `TSA PRECHECK` from
  `travel-program`, `FHR` and `HOTEL COLLECTION` from `hotel`, `AIRLINE FEE`/`AIRLINE INCIDENTAL` from
  `airline`, and the brand list in `credit-name.ts` (Uber One, Walmart+, Resy, lululemon, Oura, CLEAR,
  Equinox).
- `family` lets Asset Ledger map a credit that its family rules recognised but whose text carries no
  product keyword (for example a generic `TRAVEL CREDIT` on a card with one travel credit).
- `normalizedCreditName` remains the grouping for unmatched credits only.

## 5. Periods and progress

### 5.1 Dates and arithmetic

- All dates are owner-local calendar dates (ISO `YYYY-MM-DD`), no times or time zones.
- `add_months(anchor, n)`: same day-of-month in the target month, clamped to its last day, always
  computed from the original anchor, never iteratively. `add_years(a, n) = add_months(a, 12n)`; a
  29 February anchor gives 28 February in common years. Ruby's `Date#>>` behaves this way; TypeScript
  needs a small helper.
- Money is decimal throughout (`decimal.js` via `lib/money`, `BigDecimal` in Ruby). Tolerances round half
  up to cents. Vector money values compare as decimals, not strings.

### 5.2 Reset bases and period boundaries

| `reset_basis`           | Needs                           | Periods                                                                                                                                                                       |
| ----------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calendar`              | —                               | Calendar months; quarters starting January, April, July, October; halves January–June and July–December; calendar years.                                                      |
| `anniversary`           | account anniversary `A`         | Period `m` starts at `add_months(A, m × step)` (step 1, 3, 6 or 12) and ends the day before the next start. The benefit year is `[add_years(A, k), add_years(A, k + 1) − 1]`. |
| `anniversary_statement` | `A` and statement close day `d` | Annual only. `S_k` = first date on or after `add_years(A, k)` whose day is `min(d, days in month)`. Year 1 is `[A, S_1]`; year `k` is `[S_(k−1) + 1, S_k]`.                   |
| `since_last_credit`     | —                               | Multi-year only; see §5.6.                                                                                                                                                    |

The anniversary is the account-open date. When a basis needs it and it is missing, the credit's status is
`needs_anniversary`; when the statement close day is missing, `needs_statement_day`. Matched entries are
still listed, but no periods are computed and nothing is guessed. Other credits on the card still compute
(vector bt-012).

Periods ending before the account-open date or the owner's tracking start (§5.3) are dropped; a period
straddling either date is kept whole, never prorated.

### 5.3 Versions, effective dates and tracking start

- Each version generates its own periods, intersected with `[effective_from, effective_to]`; a period cut
  by a version boundary keeps the full cap. Issuer changes almost always fall on period boundaries.
- Versions with `status: "to_verify"` generate no periods. Their entries still map (so the UI can say the
  credit is awaiting verification) but count nowhere.
- `effective_from: null` means the cited sources do not say when the terms began. Implementations treat
  it as open-ended in the past; to avoid applying today's terms to old years, each tracked account has an
  optional tracking start (default: none), and the UI labels such terms as of `last_verified`.

### 5.4 Caps, overrides and tax tolerance

- A period's cap is the version `amount`, unless the owner has an amount override for this account and
  credit whose `effective_from` (or `null` = always) is on or before the period start; the latest such
  override wins. Overrides never edit the catalog.
- A disabled credit is hidden and its entries become unmatched with `credit_disabled`.
- When `cap_excludes_tax` is true, tolerance = `round_half_up(cap × 0.15, 2)`; otherwise 0. The 0.15 is an
  engineering constant shared by the vectors, not an issuer figure. A period is over cap only above
  `cap + tolerance`.

### 5.5 Allocation and credits that post in the next period

Issuers assign a credit to the period of the purchase, but the credit can post days or weeks later, so a
credit dated early in a period may belong to the previous one. Neither project links credits to purchases,
so the default is the credit's own date, corrected only when that date produces an impossible result:

1. Place owner-pinned entries in the period whose start equals the pinned date. A pin to a date that is
   not a period start leaves the entry unplaced.
2. Place every other entry, ordered by `(date, id)`, in the period containing its date. An entry after the
   last period (a late credit past `effective_to`) becomes an orphan.
3. For each period `k` in chronological order, while `used(k) > cap(k) + tolerance(k)`: take the earliest
   unpinned entry `e` in `k`, in `(date, id)` order, for which some earlier period `j` satisfies
   `date(e) ≤ end(j) + max_posting_lag_days` and `cap(j) + tolerance(j) − used(j) ≥ amount(e)`; move `e`
   to the latest such `j`. Stop when the period is within cap or no entry can move.
4. Place each orphan the same way; an orphan that fits nowhere is reported as unplaced.

Properties: periods never become over cap because of a move; nothing moves unless a period is over cap;
an entry moves at most once; the result is deterministic. Documented limitation (vector bt-004): a
January credit for a December purchase stays in January when January has room. The owner fixes it with a
pin; a period still over cap after allocation reports `excess`, which usually means a mis-mapped credit.

### 5.6 Multi-year credits

For `multi_year` with `since_last_credit` (trusted-traveler fees), the first mapped credit opens a window
`[date, add_years(date, period_years) − 1]`. Later credits inside the window join it; the next credit
after it opens a new window. Issuers grant one credit per window, so while a window covers the reference
date the credit is `eligible: false` and reports `next_eligible_on = window end + 1`; otherwise it is
`eligible: true`. No allocation or tolerance applies.

### 5.7 Output

Per tracked credit for the selected benefit year:

```json
{
  "credit": "dining",
  "status": "ok",
  "year": {
    "start": "2026-01-01",
    "end": "2026-12-31",
    "cap": "200.00",
    "used": "90.00",
    "expired_unused": "10.00",
    "available": "0.00",
    "upcoming": "100.00",
    "excess": "0.00"
  },
  "periods": [
    {
      "start": "2026-01-01",
      "end": "2026-03-31",
      "cap": "50.00",
      "used": "40.00",
      "remaining": "10.00",
      "state": "partial",
      "entries": ["e1"]
    }
  ],
  "unplaced": []
}
```

- `state`: `upcoming` (starts after as-of), else `unused` (used 0), `partial` (below cap), `full` (up to
  cap + tolerance) or `over`.
- `remaining = max(0, cap − used)`; `excess = max(0, used − cap − tolerance)`.
- Year: `cap` and `used` sum the listed periods; `expired_unused` sums `remaining` of periods that ended
  before as-of; `available` is the current period's `remaining`; `upcoming` sums caps of future periods.
- `status` is `ok`, `needs_anniversary`, `needs_statement_day` or `to_verify`; the last three carry only
  `entries`. Credits with non-statement delivery or no period in the year are not listed.

### 5.8 Which benefit year is shown

Asset Ledger's page selects a calendar year `Y`. The reference date is the as-of date when `Y` is the
current year, otherwise `Y-12-31`; each credit shows the benefit year, under the basis of the version in
effect at the reference date, that contains it. Calendar credits therefore show `Y`; anniversary credits
show their card year (labelled with its dates, e.g. 2026-03-15 至 2027-03-14). Listed periods are those
starting inside that benefit year.

## 6. Test vectors

### 6.1 Format

[test-vectors.json](benefit-tracker/test-vectors.json) holds
`{ format, format_version, constants: { tax_tolerance_rate }, vectors: [...] }`. Each vector:

| Field       | Meaning                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`        | `bt-NNN`, stable.                                                                                                                                                                    |
| `catalog`   | One product in the §3 format, with `status: "synthetic"` versions and a fictional issuer.                                                                                            |
| `account`   | `{ currency, product_id, anniversary, statement_close_day, tracking_start }`; `product_id: null` means no product selected.                                                          |
| `overrides` | `[{ credit, effective_from, amount, disabled }]`.                                                                                                                                    |
| `entries`   | Benefit credits: `{ id, date, amount, currency, description, merchant?, family?, assigned_credit?, assigned_period_start? }`. A present `assigned_credit: null` is an explicit none. |
| `as_of`     | Owner-local today.                                                                                                                                                                   |
| `view_year` | Selected calendar year (§5.8).                                                                                                                                                       |
| `expect`    | `{ matches: { entryId: creditId \| null }, unmatched: [{ entry, reason }], instances: [...] }`, instances as in §5.7 or the multi-year form.                                         |

Comparison rules: money as decimals; `unmatched` as a set; `entries` lists in `(date, id)` order;
`instances` in catalog order.

### 6.2 Coverage

| Vector | Behaviour                                                                   |
| ------ | --------------------------------------------------------------------------- |
| bt-001 | Calendar monthly: full, partial, current, upcoming; year summary            |
| bt-002 | Over-cap quarter moves its earliest credit within the lag back              |
| bt-003 | Credits beyond the lag stay; `over` and `excess`                            |
| bt-004 | No overflow, no move (documented limitation)                                |
| bt-005 | Owner-pinned period                                                         |
| bt-006 | Semiannual calendar with year summary                                       |
| bt-007 | Anniversary year with a late credit moved to the previous card year         |
| bt-008 | Anniversary quarters clamped to month end from a 31st anchor                |
| bt-009 | 29 February anniversary                                                     |
| bt-010 | Statement-anniversary year                                                  |
| bt-011 | Missing anniversary → `needs_anniversary`                                   |
| bt-012 | Missing statement day → `needs_statement_day`; other credits still compute  |
| bt-013 | Benefit refresh across versions, late credit moved into the old version     |
| bt-014 | `effective_to` plus lag: orphan placed, later credit `no_effective_version` |
| bt-015 | Dated amount override; disabled credit                                      |
| bt-016 | Normalization, whole words, specificity, tie, exclusion, merchant field     |
| bt-017 | Owner assignment and explicit none                                          |
| bt-018 | Family fallback: unique, ambiguous, keyword precedence                      |
| bt-019 | Currency mismatch                                                           |
| bt-020 | No product selected                                                         |
| bt-021 | Cap plus tax: tolerance and a move that needs it                            |
| bt-022 | Multi-year window                                                           |
| bt-023 | To-verify version maps entries but computes nothing                         |

### 6.3 Example: bt-002

Quarterly credit, cap 50.00, lag 56 days. Credits on 2026-04-06 (40.00) and 2026-05-20 (50.00); as-of
2026-06-15. Q2 holds 90.00 > 50.00. The earliest Q2 credit, 2026-04-06, is within 56 days of Q1's end
(2026-03-31 + 56 = 2026-05-26) and fits Q1's room of 50.00, so it moves.

| Period                  | Cap   | Used  | State    | Entries |
| ----------------------- | ----- | ----- | -------- | ------- |
| 2026-01-01 – 2026-03-31 | 50.00 | 40.00 | partial  | e1      |
| 2026-04-01 – 2026-06-30 | 50.00 | 50.00 | full     | e2      |
| 2026-07-01 – 2026-09-30 | 50.00 | 0.00  | upcoming |         |
| 2026-10-01 – 2026-12-31 | 50.00 | 0.00  | upcoming |         |

Year: cap 200.00, used 90.00, expired unused 10.00, available 0.00, upcoming 100.00.

### 6.4 Provenance and use

The expectations were computed by a throwaway reference script written from this spec and spot-checked by
hand (bt-001, 002, 003, 007, 008, 013, 014, 015, 021). The script is not committed; the vectors are the
contract. Asset Ledger runs them in Vitest, Sure in Minitest, both reading the same vendored file. A
behaviour change bumps `format_version` and lands in CardFacts first.

## 7. Asset Ledger implementation outline

### 7.1 Catalog

- Vendor CardFacts' `dist/cards.json` as `apps/web/lib/benefits/catalog/catalog.json` with its version and SHA-256
  in a sibling `catalog.lock.json`.
- `lib/benefits/catalog/index.ts` parses it with a strict zod schema at module load (failing tests and
  build on invalid data) and exports typed products. Nothing is fetched at runtime.

### 7.2 Schema

Three owned tables (UUID `id`, `owner_id`, `created_at`, `updated_at`, composite foreign keys on
`(owner_id, account_id)` like the existing tables):

| Table                      | Columns                                                                                                             | Notes                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `card_benefit_profiles`    | `account_id`, `catalog_product_id text`, `tracking_start date null`                                                 | Unique `(owner_id, account_id)`. Non-system `liability_credit_card` accounts only.          |
| `card_benefit_overrides`   | `account_id`, `catalog_credit_id text`, `effective_from date null`, `amount numeric(20,4) null`, `disabled boolean` | Unique `(owner_id, account_id, catalog_credit_id, effective_from)` with nulls not distinct. |
| `card_benefit_assignments` | `lineage_key text`, `catalog_credit_id text null`, `period_start date null`                                         | Unique `(owner_id, lineage_key)`. `catalog_credit_id` null means "not a catalog credit".    |

- The anniversary is the existing `accounts.opened_on` and the statement close day the existing
  `accounts.statement_day`, both already in the account form. No new account columns (see §10, Q5).
- `lineage_key` reuses the transfer-memory identity (`legKey` in
  [match-pool.ts](../apps/web/lib/bank-sync/match-pool.ts): the provider transaction key, otherwise the
  replacement-chain root), extracted into a shared helper. Assignments then survive void-and-replace and
  Plaid reset/reimport, as transfer choices do.
- Catalog ids are stored as text, not foreign keys. An id that disappears from a newer catalog is shown
  as a stale setting the owner can clear, never silently dropped.
- Migration generated with `db:generate`; additive only.

### 7.3 Services

- Pure modules under `lib/benefits/progress/`: `normalize.ts` (§4.4), `match.ts` (§4.3), `periods.ts`
  (§5.1–5.3), `allocate.ts` (§5.5), `summary.ts` (§5.6–5.7), and `index.ts` exposing
  `benefitProgress(input)` with the vector input and output shapes. No database access, no `number`
  for money.
- `queries.ts`: `benefitOverview` additionally loads profiles, overrides and assignments for the owner,
  keeps using `benefitRecords`, calls `benefitProgress` per card, and returns `progress` alongside the
  existing `byName` (now built from unmatched entries only), `annual` and `rolling`.
- `lib/benefits/profile.ts`: `setBenefitProfile`, `setBenefitOverride`, `setBenefitAssignment`. Each
  takes `(db, ownerId, …)`, validates with strict zod, runs in a transaction with row locks, checks
  ownership, account type and that catalog ids exist, and writes an audit record
  (`benefit_profile.set|clear`, `benefit_override.set|clear`, `benefit_assignment.set|clear`) containing
  entity ids and catalog ids only. No amounts or descriptions in logs.
- No change to `detectBenefit`, `editBenefit`, `benefitInput`, rescans or postings.

### 7.4 API and UI

Thin route handlers under `app/api/benefits/` (`profile`, `overrides`, `assignments`) using `ledgerRoute`.

On the existing [/benefits](<../apps/web/app/(app)/benefits/page.tsx>) page:

- Card tile: when the card has a product, the second line reads `已用 $X / $Y`, totalled across its
  tracked credits for the selected year in the card currency; otherwise unchanged.
- Detail sheet: a 权益进度 section above the existing list. One row per tracked credit: official name,
  period and basis label, a progress bar for the current period, then 本期剩余 / 已过期未用 / 待开始.
  Rows expand to periods and their entries (links to `/activity?entryId=…`, as today). The existing
  type groups follow under 其他权益 for unmatched credits.
- Sheet footer: 卡产品 selector and per-credit settings (自定义额度, 不追踪此权益).
- Entry detail ([editor.tsx](../apps/web/components/benefits/editor.tsx)): 对应权益 and 计入周期 selects.

Copy (Simplified Chinese; official names stay in English):

| Key                 | Copy                                                             |
| ------------------- | ---------------------------------------------------------------- |
| Section title       | 权益进度                                                         |
| Product field       | 卡产品                                                           |
| No product          | 未选择卡产品，仅按类型分组                                       |
| Product help        | 选择后按发卡机构公开条款计算各项权益的使用进度。                 |
| Product suggestion  | 可能是 {name}，请确认                                            |
| Periods             | 每月 / 每季度 / 每半年 / 每年 / 每 {n} 年                        |
| Bases               | 自然年 / 卡年度 / 账单年度                                       |
| States              | 未使用 / 部分使用 / 已用满 / 超出额度 / 未开始                   |
| Totals              | 已用 {used} / {cap} · 本期剩余 {x} · 已过期未用 {x} · 待开始 {x} |
| Needs anniversary   | 请在账户设置中填写开卡日期，以计算卡年度进度。                   |
| Needs statement day | 请在账户设置中填写账单日，以计算账单年度进度。                   |
| Excess              | 超出额度 {x}，请检查是否对应错误。                               |
| To verify           | 条款待核实，暂不计算进度。                                       |
| Multi-year          | 已使用，{date} 起可再次使用 / 可使用                             |
| Override amount     | 自定义额度                                                       |
| Override start      | 生效起始                                                         |
| Disable             | 不追踪此权益                                                     |
| Entry mapping       | 对应权益：自动匹配 / {credit} / 不对应（其他权益）               |
| Entry period        | 计入周期：按入账日期 / {period}                                  |
| Source              | 条款来源：{source title} · 核实于 {date}                         |
| Unmatched group     | 其他权益                                                         |

### 7.5 Data management

- Add the three tables to `ownerTables` in [tables.ts](../apps/web/lib/data/tables.ts) (children before
  `accounts`), so personal export and delete-all cover them.
- Plaid reset keeps them, like transfer memory.
- Progress is never part of net worth, income, spending or rewards.

### 7.6 Tests

- `tests/benefit-vectors.test.ts` runs every vector through `benefitProgress`.
- PGlite integration: owner isolation (another owner's account or entry is rejected), audit actions,
  assignment surviving `replaceEntry` and Plaid reset/reimport, stale catalog ids, export and delete-all.
- Page test with synthetic data: tiles, sheet sections, `needs_*` prompts and the 其他权益 fallback.

### 7.7 Suggested phases

1. Pure progress modules plus vectors (no schema, no UI).
2. Schema, profile service, audit, export and delete-all.
3. Query integration and the /benefits UI.
4. Entry-level assignment UI.

## 8. Sure storage sketch

Sketch for the Discussion; the maintainers decide the details.

- Vendored data: `config/card_benefits/catalog.json`, loaded once by `CardBenefits::Catalog`.
- `credit_cards` gains `benefit_product_id :string` and `opened_on :date`. The opening date also suits
  future card features, and `statement_close_day` already exists.
- `card_benefit_overrides`: `credit_card_id`, `credit_id :string`, `effective_from :date`,
  `amount :decimal(19,4)`, `disabled :boolean`, scoped through the account's family.
- Assignments: `transactions.extra["card_benefit"] = { "credit_id" => …, "period_start" => … }`. Sure
  already namespaces provider data in `extra`; a dedicated key keeps it clear of sync writes, and the
  entry's `locked_attributes` can protect it.
- Detection: Sure has no benefit flag, so candidates are the §4.1 inflows whose text hits a catalog
  keyword of the card's product; the family fallback does not apply. A rule action such as "Mark as card
  benefit" could come later.
- POROs `CardBenefits::Matcher`, `::Periods`, `::Progress` with `BigDecimal` and `Date#>>`.
- UI: a Benefits tab next to `credit_cards/tabs/_overview`, with English copy in the locale files.
- Tests: `test/models/card_benefits/vectors_test.rb` over the vendored `test-vectors.json`.

## 9. Proposed change to decisions.md §卡权益

The current section keeps identification keyword-only and names from descriptions, with no per-card
catalog. Adding a catalog is a new product decision. Proposed diff, for approval, not applied:

```diff
 ## 卡权益

 - 卡权益在独立页面展示，与积分里程分开。
 - 只针对信用卡正入账，通过集中维护的关键词规则识别权益。
 - 具体权益类型优先于泛化 Credit、Benefit 或 reimbursement 关键词。
 - 明确还款词阻止权益识别；通用词还需排除退款、利息、积分兑换等含义。
 - 商户 Offer 是普通退款，不是卡权益；编辑选项和权益统计排除 Offer。
 - 含 Offer 且无明确还款词的卡退款不因上游转入分类而变成转账或收入。
 - 权益使用退款分录及权益类型标记，抵减支出，不另加收入或净资产。
 - 分类取该权益配置中首个可用支出分类，否则使用其他支出。
 - 只记录返还，不搜索或创建原消费链接；既有链接保留且不在权益界面展示。
 - PDF、CSV 导入中的权益识别仅为建议，仍经过审核。
-- 页面按卡、年份及简短 Credit / Benefit 类型分组，支持近 12 月统计与逐笔下钻。
-- 类型名称从描述或商户中去掉机构、产品、数字和参考号，无有效名称时归为其他权益。
+- 页面按卡和年份展示目录权益进度，其余权益按简短 Credit / Benefit 类型分组，支持近 12 月统计与逐笔下钻。
+- 未对应目录的类型名称从描述或商户中去掉机构、产品、数字和参考号，无有效名称时归为其他权益。
 - 统计仅使用有效已确认退款；自动重扫不覆盖所有者编辑、已匹配或上游待审核记录。
+- 权益进度使用独立宽松许可仓库维护的公开权益目录，固定版本随代码入库，运行时不联网获取。
+- 目录金额必须引用发卡机构公开条款并记录核实日期；未核实条目标为待核实，不计算进度。
+- 所有者为信用卡选择卡产品后才计算进度；机构和账户名称只用于建议，不自动认定。
+- 识别仍由上述关键词规则决定；目录只把已识别的权益对应到具体 Credit，依次按所有者指定、目录关键词和唯一同类权益。
+- 无法唯一对应、币种不符、不在生效期或已停用的权益仍按类型归入其他权益。
+- 周期按自然年、卡年度或账单年度切分；缺少开卡日期或账单日时提示补充，不推算进度。
+- 返还按入账日计入周期；周期超出额度时，入账延迟窗口内较早的返还可计入仍有余量的上一周期，所有者可逐笔指定周期。
+- 所有者可调整某卡某项 Credit 的额度或停用追踪，不修改目录；卡产品、额度调整和逐笔指定均记录审计，并按稳定来源身份跨替换与重置保留。
+- 进度是展示用汇总，只读取已有退款；不改动分录、分类或权益类型，不创建消费链接，不进入收入、支出或净资产。
```

If approved, AGENTS.md's benefit invariant gains one matching line in the implementation pull request.

## 10. Open questions for the owner

1. **Approve the decision change (§9)?** It reverses the no-catalog stance for progress only; detection
   stays keyword-only.
2. **Catalog repository:** created as [CardFacts](https://github.com/WeiqiZhou2002/cardfacts) on the personal
   account, with CC0-1.0 data and MIT code as recommended. Open: whether to move it to an organisation later.
3. **Late-posting rule (§5.5):** keep the overflow-triggered move plus manual pin, or use the posting date
   only and rely on pins? The move fixes the common "two credits in one month" case but never the "January
   credit for December" case (bt-004).
4. **Tax tolerance:** is 15 % of the cap acceptable for "plus applicable taxes" credits?
5. **Anniversary source:** reuse `accounts.opened_on` (one source of truth; it also bounds net-worth
   backcasting, which is correct for a card) or add a dedicated `anniversary_on` to the profile?
6. **Statement-anniversary edge:** Chase says the year ends at the first statement date after the
   anniversary. The spec reads this as on or after; confirm against a cardmember agreement before the
   vectors are frozen.
7. **Inferred boundaries:** Amex quarters and months and Chase Peloton months are not spelled out; the
   catalog marks them `inferred` as calendar periods. Acceptable, or keep such credits annual-only until
   stated?
8. **Unknown `effective_from`:** both refreshed products lack a cited start date. Accept null plus tracking
   start, or hold those products back until an issuer source gives the date?
9. **To-verify items:** Venture X amounts and reset basis; Amex Equinox and Airbnb Experiences; The Edit
   before 2026. Do you want these researched further in CardFacts?
10. **Non-statement benefits:** show Uber Cash, Lyft and DoorDash as an informational, untracked list, or
    leave them out of the UI entirely?
11. **Product changes:** v1 allows one product per account. Is a product-change history (for upgrades
    mid-year) needed now?
12. **Credit reversals:** issuer reversals are card debits, which are never benefits under current rules,
    so `used` can overstate after a reversal. Accept for v1?
13. **Where the drafts live:** canonical copies are now in CardFacts. Keep `docs/benefit-tracker/` here for
    review, or drop it before the Asset Ledger pull request?
