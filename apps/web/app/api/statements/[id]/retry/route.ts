import { ledgerRoute } from "@/lib/ledger/http";
import { retryStatement } from "@/lib/imports/service";
export const POST = ledgerRoute(
  async (_request, { db, ownerId, id }) => retryStatement(db, ownerId, id!),
  true,
);
