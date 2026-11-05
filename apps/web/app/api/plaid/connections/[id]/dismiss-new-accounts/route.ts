import { plaidRoute } from "@/lib/bank-sync/http";
import { dismissNewAccounts } from "@/lib/bank-sync/connections";

export const POST = plaidRoute(async (_request, { db, ownerId, id }) => {
  return dismissNewAccounts(db, ownerId, id!);
}, true);
