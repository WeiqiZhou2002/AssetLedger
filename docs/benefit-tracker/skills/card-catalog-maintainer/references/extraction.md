# Extraction and versioning reference

How to turn issuer wording into data fields. The schema in `schema/card.schema.json` and the vocabularies in
`vocab/` are authoritative; this file explains how to read the pages.

## General

- Extract only from the text fetched in this run. Do not fill a field from memory, from another card, or
  from a lead.
- Prefer the most specific issuer document: benefit terms or the Guide to Benefits over the marketing page,
  and the rates-and-fees page for fees. Cite the page where the number actually appears.
- Money is a decimal string with two places (`"895.00"`). Rates are decimal strings (`"5"`, `"1.5"`).
- `notes` is your own short paraphrase. Quote at most a few words, only when the exact wording decides a
  field (for example "plus applicable taxes").

## Fees

| Wording                                           | Field                                                    |
| ------------------------------------------------- | -------------------------------------------------------- |
| "Annual Fee: $X"                                  | `annual_fee: "X"`                                        |
| "$0 intro annual fee for the first year, then $X" | `first_year_annual_fee: "0.00"`, `annual_fee: "X"`       |
| "$X for each authorized user" / "Additional Card" | `authorized_user_fee: "X"`; `null` if the page is silent |
| "No foreign transaction fees"                     | `foreign_transaction_fee_percent: "0"`                   |
| "N% of each transaction after conversion to USD"  | `foreign_transaction_fee_percent: "N"`                   |

Promotional or targeted fee offers are not fees; ignore them.

## Earn rates

- Map the category to `vocab/earn-categories.json`. If nothing fits, do not invent a category: leave the
  rule out and flag it in the pull request.
- Channel: "booked directly with" → `direct`; "through <issuer> Travel" or the issuer's portal →
  `issuer_portal`; both named → both channels.
- "on up to $X per calendar year" → `cap: { amount: "X", period: "annual", reset_basis: "calendar" }`;
  "each quarter" → `period: "quarterly"`. `rate_after_cap` only when the page states it, else `null`.
- "U.S. supermarkets", "U.S. gas stations" → `region: "US"` on the condition, same category.
- Quarterly activated rotating categories → `category: "rotating"` with the quarter's schedule only when the
  issuer has published it; otherwise flag.
- Points versus cash comes from the product's `rewards.unit`; a page saying "5% cash back" on a points card
  is a mismatch to flag, not to fix.

## Credits

| Wording                                                         | Field                                                                         |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| "each month", "monthly"                                         | `period: "monthly"`                                                           |
| "each quarter", "quarterly"                                     | `period: "quarterly"`                                                         |
| "semi-annually (January to June and July to December)"          | `period: "semiannual"`, `period_boundaries: "stated"`                         |
| "per calendar year", "each calendar year"                       | `period: "annual"`, `reset_basis: "calendar"`                                 |
| "each account anniversary year", "Card Membership year"         | `period: "annual"`, `reset_basis: "anniversary"`                              |
| "through the first statement date after your anniversary"       | `reset_basis: "anniversary_statement"`                                        |
| "every four years"                                              | `period: "multi_year"`, `period_years: 4`, `reset_basis: "since_last_credit"` |
| "plus applicable taxes"                                         | `cap_excludes_tax: true`                                                      |
| "Enrollment required"                                           | `enrollment: "required"`                                                      |
| "Activation required"                                           | `enrollment: "activation"`                                                    |
| "Uber Cash", "in-app credits", "promos" applied by the merchant | `delivery: "issuer_wallet"` or `"in_app"`                                     |
| "allow up to 8 weeks for credits to post"                       | `max_posting_lag_days: 56`                                                    |
| "may take 90 days"                                              | `max_posting_lag_days: 90`                                                    |
| "through 12/31/2027"                                            | `effective_to: "2027-12-31"`                                                  |
| "Starting 1/1/2026", "Effective January 1, 2027"                | `effective_from`, `effective_from_basis: "stated"`                            |

- Cadence stated without boundaries ("each quarter") → calendar periods with `period_boundaries:
"inferred"`.
- Pick `category` from `vocab/credit-categories.json`.
- New credits need at least one `match.keywords` entry: the brand or program name in uppercase (`RESY`,
  `STUBHUB`). Never use text from anyone's statement.
- An eligibility change with no amount change (for example a new minimum stay) is a `notes` update on the
  current version, not a new version.

## Versioning

When a value of a current version changes:

1. Determine the new start date. If the page states it, use it with `effective_from_basis: "stated"`.
   Otherwise use today's date with `effective_from_basis: "detected"`, and state in the pull request the
   window in which the change happened: after the old version's `last_verified`, on or before today.
2. Set the old version's `effective_to` to the day before the new start. Leave every other field of the old
   version as it is.
3. Append the new version with `status: "verified"`, `source`, `last_verified: today` and a `notes`
   paraphrase.
4. If the new value is not readable, append the new version with `status: "to_verify"` and `amount: null`
   (or `rate: null`) instead of guessing.

When a future change is announced (stated start date after today), add the new version now with that
`effective_from` and close the current version the day before; the data stays correct on both sides of the
date.

Re-verification without a value change only updates `last_verified` on versions whose values you found in
the fetched text.
