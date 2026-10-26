import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { loyaltyEvents } from "@/db/schema";
import { ledgerBody, ledgerRoute } from "@/lib/ledger/http";
import { createEvent } from "@/lib/rewards/service";
export const GET = ledgerRoute(async (request, { db, ownerId }) => {
  const id = request.nextUrl.searchParams.get("accountId");
  return db
    .select()
    .from(loyaltyEvents)
    .where(
      and(
        eq(loyaltyEvents.ownerId, ownerId),
        id ? eq(loyaltyEvents.loyaltyAccountId, z.uuid().parse(id)) : undefined,
      ),
    )
    .orderBy(loyaltyEvents.eventDate);
});
export const POST = ledgerRoute(
  async (request, { db, ownerId }) => createEvent(db, ownerId, await ledgerBody(request)),
  true,
);
