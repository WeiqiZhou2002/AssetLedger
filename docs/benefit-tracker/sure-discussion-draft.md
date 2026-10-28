# Draft: Discussion post for we-promise/sure

Not posted. Intended category: Feature Requests, whose template asks for the three sections below. Drop
this file before any Asset Ledger pull request if the owner prefers not to publish it.

---

**Title:** Card benefit progress: see how much of each credit card statement credit is left this period

### Describe the feature

Premium credit cards bundle statement credits that reset on different schedules: a dining credit every
quarter, a hotel credit every half year, a streaming credit every month, a travel credit every card year.
Sure already imports the credits as inflows on the card, but nothing tells you that this quarter's credit
is still unused or that last half's expired.

I'd like to propose a small, opt-in benefit tracker for credit card accounts:

1. On a credit card account, the user picks the card product from a catalog (for example "Chase Sapphire
   Reserve"), and optionally enters the account-open date for anniversary-based credits.
2. Sure matches inflows on that card to the product's credits by keyword (for example `RESY`, `STUBHUB`),
   with a manual override per transaction.
3. A Benefits tab on the account shows, for each credit: the cap, how much is used and left in the current
   period, what expired unused this year, and what is still to come, with drill-down to the transactions.

Rough shape in Sure:

- `credit_cards.benefit_product_id` and `credit_cards.opened_on` (`statement_close_day` is already there
  and covers issuers whose card year ends on a statement date);
- a small `card_benefit_overrides` table for custom caps or "don't track this credit";
- a namespaced key in `transactions.extra` for manual assignments;
- plain Ruby objects for matching and period math, and a Benefits tab next to Overview.

Out of scope: linking a credit to the purchase that earned it, perks that never post to the card (Uber
Cash, in-app promos), enrollment tracking, and any effect on net worth or budgets.

### Why is this feature important?

- Annual fees on these cards are $395–$895, justified largely by credits that only pay off if you use
  them before they reset. Forgetting one quarter is real money.
- The reset rules are hard to keep in your head: calendar month, quarter or half; calendar year versus card
  year; and at least one issuer whose card year ends on the first statement after the anniversary.
- Credits often post days or weeks after the purchase, so "did I use January's credit?" isn't answerable by
  scrolling transactions.
- Sure already has the transactions and the card. The missing piece is knowing what each card offers,
  which is public information.

### Additional context, screenshots, and relevant links

**Shared data instead of shared code.** I maintain [Asset Ledger](https://github.com/WeiqiZhou2002/AssetLedger),
a self-hosted personal finance app (also AGPL), and plan to build the same feature there. Rather than
couple the projects, the plan is a shared open dataset, [CardFacts](https://github.com/WeiqiZhou2002/cardfacts), which also
covers annual fees and earn rates for personal and business cards. For this feature it holds:

- a JSON catalog of card products and their credits: amount, period (monthly, quarterly, semiannual,
  annual, multi-year), reset basis (calendar, anniversary, statement anniversary), effective dates for
  benefit refreshes, matching keywords, and for every amount a link to the issuer's public terms and a
  `last_verified` date. Unverified values are explicitly marked, never guessed;
- language-neutral test vectors (input credits and dates → expected period progress) that a Ruby and a
  TypeScript implementation must both pass;
- data licensed CC0-1.0, so Sure can vendor a pinned copy under `config/` with no attribution UI and no
  runtime network calls.

A full draft spec (format, matching rules, period math including late-posting credits, and the vectors)
is ready, and I'm happy to share it here.

**About me:** I recently opened #4547 (Plaid credit card links for issuers without Liabilities), so I'm
fairly familiar with the credit card and Plaid code paths. I'd be glad to contribute this in small pull
requests: matching and period POROs with the vectors first, then the schema, then the UI.

**Questions for maintainers:**

1. Is this something you'd want in Sure, perhaps behind a family setting?
2. Is a Benefits tab on the credit card account the right place, or would you rather see a dashboard
   widget?
3. Is vendoring a CC0 JSON file under `config/` acceptable, with updates arriving as ordinary pull
   requests?
4. Would you prefer `opened_on` on `credit_cards` or on `accounts` (it could serve loans too)?
