import { plaidRoute } from "@/lib/bank-sync/http";
import { refreshConnection, queueSync } from "@/lib/bank-sync/connections";
import { readAccountSelection } from "@/lib/bank-sync/account-selection";
export const POST = plaidRoute(async (request, { db, ownerId, client, config, id }) => {
  await refreshConnection(db, ownerId, id!, client, config, new Date(), await readAccountSelection(request));
  return queueSync(db, ownerId, id!, config, false);
}, true);
