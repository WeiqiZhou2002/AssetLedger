import { plaidRoute } from "@/lib/bank-sync/http";
import { refreshConnection, queueSync } from "@/lib/bank-sync/connections";
export const POST = plaidRoute(async (_request, { db, ownerId, client, config, id }) => {
  await refreshConnection(db, ownerId, id!, client, config);
  return queueSync(db, ownerId, id!, config, false);
}, true);
