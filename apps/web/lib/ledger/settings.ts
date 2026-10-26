import { eq } from "drizzle-orm";
import { userSettings } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { settingsSchema } from "./schemas";
import { auditLedger } from "./audit";
export async function getSettings(db: AppDb, ownerId: string) {
  const [existing] = await db.select().from(userSettings).where(eq(userSettings.ownerId, ownerId));
  return existing ?? { prepaymentMode: "asset" as const, spendingDateBasis: "posted" as const };
}
export async function updateSettings(db: AppDb, ownerId: string, input: unknown) {
  const values = settingsSchema.parse(input);
  return db.transaction(async (tx) => {
    const [settings] = await tx
      .insert(userSettings)
      .values({ ownerId, ...values })
      .onConflictDoUpdate({ target: userSettings.ownerId, set: values })
      .returning();
    await auditLedger(tx, ownerId, "user_settings", settings.id, "settings.update", values);
    return settings;
  });
}
