import { z } from "zod";
import { auditLogs } from "@/db/schema";
import type { AppDb } from "@/db/types";
const details = z
  .object({
    connectionIds: z.array(z.uuid()).max(25),
    count: z.number().int().min(0).max(25),
    existingCount: z.number().int().min(0).max(25).optional(),
    failedCount: z.number().int().min(0).max(25).optional(),
  })
  .strict();
export async function auditConnectionTransfer(
  db: AppDb,
  ownerId: string,
  action: "bank.connections_exported" | "bank.connections_imported",
  changes: z.infer<typeof details>,
) {
  // Dedicated closed IDs/counts allowlist; do not relax the shared redaction layer.
  await db.insert(auditLogs).values({
    ownerId,
    actorUserId: ownerId,
    entityType: "user",
    entityId: ownerId,
    action,
    changes: details.parse(changes),
  });
}
