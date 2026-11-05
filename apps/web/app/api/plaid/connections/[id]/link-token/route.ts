import { plaidRoute } from "@/lib/bank-sync/http";
import { createLinkToken } from "@/lib/bank-sync/connections";
import { readAccountSelection } from "@/lib/bank-sync/account-selection";
export const POST = plaidRoute(async (request, { db, ownerId, client, config, id }) => {
  return createLinkToken(
    db,
    ownerId,
    client,
    config,
    "transactions",
    id!,
    new Date(),
    await readAccountSelection(request),
  );
}, true);
