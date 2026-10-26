import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts } from "@/db/schema";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
it("upgrades the suffix check without altering stored accounts and reapplies safely", async () => {
  const h = await createTestDb(20);
  try {
    const f = await ledgerFixture(h.db);
    await h.db.update(accounts).set({ last4: "0005" }).where(eq(accounts.id, f.card.id));
    const before = await h.db.select().from(accounts);
    await expect(
      h.db.update(accounts).set({ last4: "10005" }).where(eq(accounts.id, f.card.id)),
    ).rejects.toThrow();
    await h.applyMigrations();
    await h.applyMigrations();
    expect(await h.db.select().from(accounts)).toEqual(before);
    await h.db.update(accounts).set({ last4: "10005" }).where(eq(accounts.id, f.card.id));
    expect((await h.db.select().from(accounts).where(eq(accounts.id, f.card.id)))[0].last4).toBe("10005");
    await expect(
      h.db.update(accounts).set({ last4: "110005" }).where(eq(accounts.id, f.card.id)),
    ).rejects.toThrow();
  } finally {
    await h.client.close();
  }
});
