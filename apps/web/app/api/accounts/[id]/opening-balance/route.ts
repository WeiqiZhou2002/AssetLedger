import { ledgerBody, ledgerRoute } from "@/lib/ledger/http";
import { confirmObservedOpening } from "@/lib/ledger/opening-observation";
export const POST = ledgerRoute(
  async (request, { db, ownerId, id }) => confirmObservedOpening(db, ownerId, id!, await ledgerBody(request)),
  true,
);
