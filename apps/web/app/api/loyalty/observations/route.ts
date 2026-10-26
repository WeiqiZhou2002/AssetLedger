import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { createObservation } from "@/lib/rewards/service";
export const POST = ledgerRoute(
  async (request, { db, ownerId }) => createObservation(db, ownerId, await ledgerBody(request)),
  true,
);
