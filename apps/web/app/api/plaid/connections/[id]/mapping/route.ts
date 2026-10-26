import { plaidRoute } from "@/lib/bank-sync/http";
import { saveMapping } from "@/lib/bank-sync/connections";
import { ledgerBody } from "@/lib/ledger/http";
export const POST = plaidRoute(async (request, { db, ownerId, config, id }) => {
  return saveMapping(db, ownerId, id!, config, await ledgerBody(request));
}, true);
