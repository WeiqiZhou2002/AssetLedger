import { ledgerRoute } from "@/lib/ledger/http";
import { observeStatementBalance } from "@/lib/imports/evidence";
export const POST = ledgerRoute(
  async (_request, { db, ownerId, id }) => observeStatementBalance(db, ownerId, id!),
  true,
);
