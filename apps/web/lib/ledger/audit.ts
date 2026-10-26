import { auditLogs } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { redactChanges } from "@/lib/auth/audit";
export async function auditLedger(
  db: AppDb,
  ownerId: string,
  entityType: string,
  entityId: string,
  action: string,
  changes: Record<string, unknown> = {},
) {
  await db
    .insert(auditLogs)
    .values({ ownerId, actorUserId: ownerId, entityType, entityId, action, changes: redactChanges(changes) });
}
