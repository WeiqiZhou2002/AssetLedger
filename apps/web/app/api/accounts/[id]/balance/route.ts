import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { updateAccountBalance } from "@/lib/ledger/balance-updates";
export const POST = ledgerRoute(
  async (request, { db, ownerId, id }) => updateAccountBalance(db, ownerId, id!, await ledgerBody(request)),
  true,
);
