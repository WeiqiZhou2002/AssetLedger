import { plaidRoute } from "@/lib/bank-sync/http";
import { queueSync } from "@/lib/bank-sync/connections";
export const POST = plaidRoute(async (_request, { db, ownerId, config, id }) => {
  return queueSync(db, ownerId, id!, config);
}, true);
