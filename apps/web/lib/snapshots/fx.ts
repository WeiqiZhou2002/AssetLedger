import { and, desc, eq, lte } from "drizzle-orm";
import { fxRates, snapshotFx } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { invariant } from "@/lib/ledger/errors";
import { auditLedger } from "@/lib/ledger/audit";
import { fxSchema } from "./schemas";
export async function listFxRates(db: AppDb, ownerId: string) {
  return db
    .select()
    .from(fxRates)
    .where(eq(fxRates.ownerId, ownerId))
    .orderBy(desc(fxRates.observedOn), desc(fxRates.createdAt), desc(fxRates.id));
}
export async function findFxRate(db: AppDb, ownerId: string, base: string, quote: string, date: string) {
  const [row] = await db
    .select()
    .from(fxRates)
    .where(
      and(
        eq(fxRates.ownerId, ownerId),
        eq(fxRates.baseCurrency, base),
        eq(fxRates.quoteCurrency, quote),
        lte(fxRates.observedOn, date),
      ),
    )
    .orderBy(desc(fxRates.observedOn), desc(fxRates.createdAt), desc(fxRates.id))
    .limit(1);
  return row ?? null;
}
export async function saveFxRate(db: AppDb, ownerId: string, input: unknown, id?: string) {
  const values = fxSchema.parse(input);
  return db.transaction(async (tx) => {
    const [row] = id
      ? await tx
          .update(fxRates)
          .set(values)
          .where(and(eq(fxRates.ownerId, ownerId), eq(fxRates.id, id)))
          .returning()
      : await tx
          .insert(fxRates)
          .values({ ...values, ownerId })
          .returning();
    invariant(row, "汇率不存在", 404);
    await auditLedger(tx, ownerId, "fx_rate", row.id, id ? "fx.update" : "fx.create");
    return row;
  });
}
export async function deleteFxRate(db: AppDb, ownerId: string, id: string) {
  return db.transaction(async (tx) => {
    // Snapshot values remain intact when the mutable rate catalog entry is deleted.
    await tx
      .update(snapshotFx)
      .set({ fxRateId: null })
      .where(and(eq(snapshotFx.ownerId, ownerId), eq(snapshotFx.fxRateId, id)));
    const [row] = await tx
      .delete(fxRates)
      .where(and(eq(fxRates.ownerId, ownerId), eq(fxRates.id, id)))
      .returning();
    invariant(row, "汇率不存在", 404);
    await auditLedger(tx, ownerId, "fx_rate", id, "fx.delete");
    return { id };
  });
}
