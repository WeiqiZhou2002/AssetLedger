export const countKeys = [
  "fetched_added",
  "fetched_modified",
  "fetched_removed",
  "imported",
  "duplicates_linked",
  "before_start_skipped",
  "pending_skipped",
  "core_sweep_skipped",
  "unmapped_skipped",
  "currency_skipped",
] as const;
export type SyncCounts = Record<(typeof countKeys)[number], number>;
// Construct a fresh allowlisted object; never spread network responses or diagnostics into logs.
export function syncCounts(input: Partial<SyncCounts> = {}): SyncCounts {
  return Object.fromEntries(
    countKeys.map((key) => [key, Math.max(0, Math.trunc(input[key] ?? 0))]),
  ) as SyncCounts;
}
