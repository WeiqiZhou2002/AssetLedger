# Pull request template

Title: `<Issuer> <Product>: <short change summary> (checked YYYY-MM-DD)`

Body:

```markdown
## What changed

| Field                      | Before | After | Effective from        |
| -------------------------- | ------ | ----- | --------------------- |
| credits.<credit-id>.amount | <old>  | <new> | <YYYY-MM-DD> (stated) |

## Evidence

- Source: <issuer URL> (`<source-id>`), fetched YYYY-MM-DD HH:MM UTC.
- Where on the page: <section heading or short locator, no long quotes>.
- Previous check with the old values: YYYY-MM-DD.

## Needs a human

- <removals, new benefits, page disagreements, anything marked to_verify, or "Nothing">

## Checks

- [x] `pnpm validate`
- [x] `pnpm build`

Opened by the card-catalog-maintainer agent. Values come only from the issuer source above; please verify
before merging.
```

Rules:

- One product per pull request; update the open bot pull request for that product instead of opening a
  second one.
- For `effective_from_basis: "detected"`, write the window in the Effective from column, for example
  `between 2026-10-20 and 2026-10-27 (detected)`.
- Re-verification pull requests use the title `Re-verify N versions (checked YYYY-MM-DD)` and list product
  ids with their sources; no value changes are allowed in them.
