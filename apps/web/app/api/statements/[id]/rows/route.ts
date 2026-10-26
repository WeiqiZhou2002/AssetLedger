import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { getStatementReview } from "@/lib/imports/service";
import { updateImportRows } from "@/lib/imports/review";
export const GET = ledgerRoute(async (_request, { db, ownerId, id }) => getStatementReview(db, ownerId, id!));
export const PATCH = ledgerRoute(
  async (request, { db, ownerId, id }) => updateImportRows(db, ownerId, id!, await ledgerBody(request)),
  true,
);
