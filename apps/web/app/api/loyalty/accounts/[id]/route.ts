import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { saveLoyaltyAccount } from "@/lib/rewards/service";
import { deleteLoyaltyAccount } from "@/lib/rewards/delete";
export const PATCH = ledgerRoute(
  async (request, { db, ownerId, id }) => saveLoyaltyAccount(db, ownerId, await ledgerBody(request), id!),
  true,
);
export const DELETE = ledgerRoute(
  async (request, { db, ownerId, id }) => deleteLoyaltyAccount(db, ownerId, id!, await ledgerBody(request)),
  true,
);
