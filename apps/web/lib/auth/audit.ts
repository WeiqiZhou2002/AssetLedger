import { auditLogs } from "@/db/schema";
import type { AppDb } from "@/db/types";
// Allow-list prevents future callers from accidentally persisting credentials or financial text.
export function redactChanges(changes: Record<string, unknown>) {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    safe[key] = key === "totpEnabled" && typeof value === "boolean" ? value : "[REDACTED]";
  }
  return safe;
}
export async function auditAuth(
  db: AppDb,
  userId: string,
  action: string,
  changes: Record<string, unknown> = {},
) {
  await db.insert(auditLogs).values({
    ownerId: userId,
    actorUserId: userId,
    entityType: "user",
    entityId: userId,
    action,
    changes: redactChanges(changes),
  });
}
