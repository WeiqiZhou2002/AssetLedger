import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import {
  transferPairRejections,
  transferPairConfirmations,
  transferAccountAssignments,
  accounts,
} from "@/db/schema";
it("upgrades existing synthetic data with owned, unique match memory and no database key-order check", async () => {
  const h = await createTestDb(19);
  try {
    const f = await ledgerFixture(h.db);
    await h.db
      .insert(transferPairRejections)
      .values({ ownerId: f.ownerId, leftKey: "entry:a", rightKey: "entry:b" });
    const before = await h.db.select().from(accounts);
    await h.applyMigrations();
    await h.applyMigrations();
    expect(await h.db.select().from(accounts)).toEqual(before);
    expect(await h.db.select().from(transferPairRejections)).toHaveLength(1);
    expect(await h.db.select().from(transferPairConfirmations)).toEqual([]);
    expect(await h.db.select().from(transferAccountAssignments)).toEqual([]);
    // PostgreSQL collation never decides ordering; the app orders opaque keys.
    const value = { ownerId: f.ownerId, leftKey: "ptx:z:Z", rightKey: "ptx:a:a" };
    await h.db.insert(transferPairConfirmations).values(value);
    await expect(h.db.insert(transferPairConfirmations).values(value)).rejects.toThrow();
    await h.db.insert(transferPairConfirmations).values({ ...value, ownerId: f.otherId });
    await h.db
      .insert(transferAccountAssignments)
      .values({ ownerId: f.ownerId, legKey: "entry:a", accountId: f.card.id });
    await expect(
      h.db
        .insert(transferAccountAssignments)
        .values({ ownerId: f.ownerId, legKey: "entry:a", accountId: f.bank.id }),
    ).rejects.toThrow();
    await expect(
      h.db
        .insert(transferAccountAssignments)
        .values({ ownerId: f.otherId, legKey: "entry:a", accountId: f.bank.id }),
    ).rejects.toThrow();
    expect(
      await h.db
        .select()
        .from(transferPairConfirmations)
        .where(eq(transferPairConfirmations.ownerId, f.otherId)),
    ).toHaveLength(1);
  } finally {
    await h.client.close();
  }
});
