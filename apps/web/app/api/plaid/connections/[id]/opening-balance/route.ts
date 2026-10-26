import { plaidRoute } from "@/lib/bank-sync/http";
import { ledgerBody } from "@/lib/ledger/http";
import { confirmOpeningBalance } from "@/lib/bank-sync/opening-balances";

export const POST = plaidRoute(
  async (request, { db, ownerId, config, id }) =>
    confirmOpeningBalance(db, ownerId, id!, config, await ledgerBody(request)),
  true,
);
