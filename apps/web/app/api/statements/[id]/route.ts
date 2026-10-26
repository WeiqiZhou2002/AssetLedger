import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { getStatementReview, setStatementAccount } from "@/lib/imports/service";
export const GET = ledgerRoute(async (_request, { db, ownerId, id }) => getStatementReview(db, ownerId, id!));
export const PATCH = ledgerRoute(async (request, { db, ownerId, id }) => {
  return setStatementAccount(db, ownerId, id!, await ledgerBody(request));
}, true);
