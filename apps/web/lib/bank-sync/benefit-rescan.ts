import { and, eq } from "drizzle-orm";
import { accounts, bankConnections } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { detectBenefit, merchantOffer } from "@/lib/benefits/config";
import { editBenefit } from "@/lib/benefits/service";
import { getEntry } from "@/lib/ledger/entries";
import { untouched, type ImportRow } from "./auto-state";
import { ownerSyncDate } from "./observations";
import { shiftDate } from "./date-range";
export const BENEFIT_VERSION = 4;
export async function rescanBenefits(
  db: AppDb,
  ownerId: string,
  connections: (typeof bankConnections.$inferSelect)[],
  rows: ImportRow[],
  now: Date,
) {
  const since = shiftDate(await ownerSyncDate(db, ownerId, now), -365);
  const accountRows = await db.select().from(accounts).where(eq(accounts.ownerId, ownerId));
  for (const connection of connections.filter((item) => item.benefitVersion < BENEFIT_VERSION)) {
    for (const row of rows) {
      if (
        row.bankConnectionId !== connection.id ||
        !row.journalEntryId ||
        row.autoPostState !== "posted" ||
        row.upstreamState !== "none"
      )
        continue;
      const account = accountRows.find((item) => item.id === row.accountId);
      if (!account) continue;
      const family = detectBenefit({
        amount: row.amount,
        accountType: account.type,
        description: `${row.descriptionRaw} ${row.merchantNormalized}`,
        primary: typeof row.upstreamPayload?.primary === "string" ? row.upstreamPayload.primary : null,
      });
      const entry = await getEntry(db, ownerId, row.journalEntryId);
      if (entry.transferMatchId || !untouched(entry)) continue;
      if (
        entry.benefitCredit &&
        (entry.benefitFamily === "offer" ||
          merchantOffer.test(`${entry.description ?? ""} ${entry.merchant ?? ""}`))
      ) {
        await editBenefit(db, ownerId, entry.id, { action: "set", enabled: false }, true);
        continue;
      }
      if (!family || entry.benefitCredit || (entry.postedDate ?? entry.eventDate) < since) continue;
      const clearing = entry.postings.some((line) =>
        accountRows.some((item) => item.id === line.accountId && item.type === "transfer_clearing"),
      );
      if (entry.entryType !== "refund" && !clearing) continue;
      await editBenefit(db, ownerId, entry.id, { action: "set", enabled: true, family }, true);
    }
    await db
      .update(bankConnections)
      .set({ benefitVersion: BENEFIT_VERSION })
      .where(and(eq(bankConnections.ownerId, ownerId), eq(bankConnections.id, connection.id)));
  }
}
