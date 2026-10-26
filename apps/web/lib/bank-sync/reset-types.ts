import { z } from "zod";
import { dateSchema } from "@/lib/ledger/schemas";
import type { PlaidConfig } from "./types";

export type ResetConfig = PlaidConfig & { DATA_DIR: string; FILE_RETENTION_DAYS: number };
export const resetInput = z
  .object({
    connections: z.union([z.literal("all"), z.array(z.uuid()).min(1).max(100)]),
    from: dateSchema.optional(),
    keepOpenings: z.boolean().default(false),
    deleteObservations: z.boolean().default(false),
  })
  .strict();
export const resetCountKeys = [
  "entries_deleted",
  "postings_deleted",
  "rows_deleted",
  "containers_deleted",
  "pending_deleted",
  "transfer_links_unlinked",
  "refund_links_cleared",
  "purchase_group_links_removed",
  "suggested_openings_deleted",
  "suggested_openings_kept",
  "other_openings_kept",
  "observations_deleted",
  "observations_kept",
  "jobs_superseded",
  "unsupported_counterparts_deleted",
] as const;
export type ResetCounts = Record<(typeof resetCountKeys)[number], number>;
export function resetCounts(input: Partial<ResetCounts> = {}): ResetCounts {
  return Object.fromEntries(
    resetCountKeys.map((key) => [key, Math.max(0, Math.trunc(input[key] ?? 0))]),
  ) as ResetCounts;
}
