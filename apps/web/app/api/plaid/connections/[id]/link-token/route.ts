import { plaidRoute } from "@/lib/bank-sync/http";
import { createLinkToken } from "@/lib/bank-sync/connections";
export const POST = plaidRoute(async (_request, { db, ownerId, client, config, id }) => {
  return createLinkToken(db, ownerId, client, config, "transactions", id!);
}, true);
