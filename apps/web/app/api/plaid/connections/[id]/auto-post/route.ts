import { plaidRoute } from "@/lib/bank-sync/http";
import { setAutoPost } from "@/lib/bank-sync/pending";
import { ledgerBody } from "@/lib/ledger/http";
export const POST = plaidRoute(
  async (request, { db, ownerId, config, id }) =>
    setAutoPost(db, ownerId, id!, config, await ledgerBody(request)),
  true,
);
