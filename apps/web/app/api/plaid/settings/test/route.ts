import { ledgerBody, ledgerRoute } from "@/lib/ledger/http";
import { savePlaidSettings } from "@/lib/bank-sync/settings";
export const POST = ledgerRoute(
  async (request, { db, ownerId }) =>
    savePlaidSettings(db, ownerId, await ledgerBody(request), undefined, true),
  true,
);
