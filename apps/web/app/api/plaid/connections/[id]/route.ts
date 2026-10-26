import { plaidRoute } from "@/lib/bank-sync/http";
import { removeConnection } from "@/lib/bank-sync/connections";
export const DELETE = plaidRoute(async (_request, { db, ownerId, client, config, id }) => {
  return removeConnection(db, ownerId, id!, client, config);
}, true);
