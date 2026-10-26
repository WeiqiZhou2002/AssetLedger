import { eq } from "drizzle-orm";
import { loyaltyCppHistory } from "@/db/schema";
import { ledgerBody, ledgerRoute } from "@/lib/ledger/http";
import { setCpp, ensurePrograms } from "@/lib/rewards/service";
export const GET = ledgerRoute(async (_request, { db, ownerId }) => {
  await ensurePrograms(db, ownerId);
  return db
    .select()
    .from(loyaltyCppHistory)
    .where(eq(loyaltyCppHistory.ownerId, ownerId))
    .orderBy(loyaltyCppHistory.effectiveDate);
});
export const POST = ledgerRoute(
  async (request, { db, ownerId }) => setCpp(db, ownerId, await ledgerBody(request)),
  true,
);
