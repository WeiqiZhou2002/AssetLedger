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

it("adds assignments after applied 0026 with unique owner-scoped FKs and entry-delete cascade", async () => {
  const { cardBenefitAssignments, journalEntries, postings } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const { createEntry } = await import("@/lib/ledger/entries");
  const { benefitInput } = await import("@/lib/benefits/input");
  const { createAccount } = await import("@/lib/ledger/accounts");
  const h = await createTestDb(27);
  try {
    const f = await ledgerFixture(h.db);
    const entry = await createEntry(
      h.db,
      f.ownerId,
      await benefitInput(h.db, f.ownerId, {
        accountId: f.card.id,
        amount: "7",
        currency: "USD",
        eventDate: "2026-03-10",
        description: "SYNTHETIC CREDIT",
        family: "generic",
      }),
    );
    const before = await h.db.select().from(journalEntries);
    await h.applyMigrations();
    expect(await h.db.select().from(journalEntries)).toEqual(before);
    const other = await createAccount(h.db, f.otherId, {
      name: "Other Synthetic Card",
      type: "liability_credit_card",
      currency: "USD",
    });
    const row = {
      ownerId: f.ownerId,
      accountId: f.card.id,
      entryId: entry.id,
      catalogProductId: "example-voyager",
      creditId: null,
    };
    await h.db.insert(cardBenefitAssignments).values(row);
    await expect(
      h.db.insert(cardBenefitAssignments).values({ ...row, creditId: "coffee" }),
    ).rejects.toThrow();
    await expect(
      h.db
        .insert(cardBenefitAssignments)
        .values({ ...row, catalogProductId: "another", accountId: other.id }),
    ).rejects.toThrow();
    await expect(
      h.db.insert(cardBenefitAssignments).values({ ...row, ownerId: f.otherId, accountId: other.id }),
    ).rejects.toThrow();
    await h.db.insert(cardBenefitAssignments).values({ ...row, catalogProductId: "example-other" });
    await h.applyMigrations();
    expect(await h.db.select().from(cardBenefitAssignments)).toHaveLength(2);
    await h.db.delete(postings).where(eq(postings.journalEntryId, entry.id));
    await h.db.delete(journalEntries).where(eq(journalEntries.id, entry.id));
    expect(await h.db.select().from(cardBenefitAssignments)).toEqual([]);
  } finally {
    await h.client.close();
  }
});
