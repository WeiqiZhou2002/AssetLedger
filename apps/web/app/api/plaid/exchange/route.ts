import { plaidRoute } from "@/lib/bank-sync/http";
import { exchangeConnection } from "@/lib/bank-sync/connections";
import { ledgerBody } from "@/lib/ledger/http";
export const POST = plaidRoute(async (request, { db, ownerId, client, config }) => {
  return exchangeConnection(db, ownerId, client, config, await ledgerBody(request));
}, true);
