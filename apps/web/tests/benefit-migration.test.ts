import { expect, it } from "vitest";
import { cardBenefitMarks, cardBenefitProfiles } from "@/db/schema";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
it("upgrades applied 0025 without changing existing profiles or retired tracking dates", async () => {
  const h = await createTestDb(26);
  try {
    const f = await ledgerFixture(h.db);
    await h.db.insert(cardBenefitProfiles).values({
      ownerId: f.ownerId,
      accountId: f.card.id,
      catalogProductId: "example-voyager",
      trackingStart: "2025-01-01",
    });
    const before = await h.db.select().from(cardBenefitProfiles);
    await h.applyMigrations();
    expect(await h.db.select().from(cardBenefitProfiles)).toEqual(before);
    await h.db.update(cardBenefitProfiles).set({ catalogProductId: null });
    expect((await h.db.select().from(cardBenefitProfiles))[0]).toMatchObject({
      catalogProductId: null,
      trackingStart: "2025-01-01",
    });
    const row = {
      ownerId: f.ownerId,
      accountId: f.card.id,
      catalogProductId: "example-voyager",
      creditId: "coffee",
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
    };
    await h.db.insert(cardBenefitMarks).values(row);
    await expect(h.db.insert(cardBenefitMarks).values(row)).rejects.toThrow();
    await expect(
      h.db.insert(cardBenefitMarks).values({ ...row, periodStart: "2026-07-01" }),
    ).rejects.toThrow();
    await expect(h.db.insert(cardBenefitMarks).values({ ...row, ownerId: f.otherId })).rejects.toThrow();
    await h.applyMigrations();
    expect(await h.db.select().from(cardBenefitMarks)).toHaveLength(1);
  } finally {
    await h.client.close();
  }
});
