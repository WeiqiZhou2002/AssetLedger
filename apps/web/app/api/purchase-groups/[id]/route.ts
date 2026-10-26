import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { updatePurchaseGroup } from "@/lib/ledger/purchase-groups";
export const PATCH = ledgerRoute(
  async (request, { db, ownerId, id }) => updatePurchaseGroup(db, ownerId, id!, await ledgerBody(request)),
  true,
);
