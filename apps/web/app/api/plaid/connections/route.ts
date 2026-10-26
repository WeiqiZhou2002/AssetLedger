import { plaidRoute } from "@/lib/bank-sync/http";
import { listConnections } from "@/lib/bank-sync/connections";
export const GET = plaidRoute(async (_request, { db, ownerId }) => {
  return listConnections(db, ownerId);
}, false);
