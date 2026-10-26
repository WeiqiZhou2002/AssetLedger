import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { updateAccount } from "@/lib/ledger/accounts";
export const PATCH = ledgerRoute(
  async (request, { db, ownerId, id }) => updateAccount(db, ownerId, id!, await ledgerBody(request)),
  true,
);
