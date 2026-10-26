import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { createPurchaseGroup, listPurchaseGroups } from "@/lib/ledger/purchase-groups";
export const GET = ledgerRoute(async (_, { db, ownerId }) => ({
  groups: await listPurchaseGroups(db, ownerId),
}));
export const POST = ledgerRoute(
  async (request, { db, ownerId }) => createPurchaseGroup(db, ownerId, await ledgerBody(request)),
  true,
);
