import { ledgerBody, ledgerRoute } from "@/lib/ledger/http";
import { resolveTransferSuggestion, transferSuggestions } from "@/lib/bank-sync/transfer-suggestions";

export const GET = ledgerRoute(async (_request, { db, ownerId }) => transferSuggestions(db, ownerId));
export const POST = ledgerRoute(
  async (request, { db, ownerId }) => resolveTransferSuggestion(db, ownerId, await ledgerBody(request)),
  true,
);
