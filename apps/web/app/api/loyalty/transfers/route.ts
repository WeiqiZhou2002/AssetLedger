import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { transferPoints } from "@/lib/rewards/service";
export const POST = ledgerRoute(
  async (request, { db, ownerId }) => transferPoints(db, ownerId, await ledgerBody(request)),
  true,
);
