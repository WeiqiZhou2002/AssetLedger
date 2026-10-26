import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { saveFxRate, deleteFxRate } from "@/lib/snapshots/fx";
export const PATCH = ledgerRoute(
  async (request, { db, ownerId, id }) => saveFxRate(db, ownerId, await ledgerBody(request), id!),
  true,
);
export const DELETE = ledgerRoute(async (_, { db, ownerId, id }) => deleteFxRate(db, ownerId, id!), true);
