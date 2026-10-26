import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { listFxRates, saveFxRate } from "@/lib/snapshots/fx";
export const GET = ledgerRoute(async (_, { db, ownerId }) => listFxRates(db, ownerId));
export const POST = ledgerRoute(
  async (request, { db, ownerId }) => saveFxRate(db, ownerId, await ledgerBody(request)),
  true,
);
