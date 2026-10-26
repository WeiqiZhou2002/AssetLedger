import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { saveCsvMapping } from "@/lib/imports/service";
import { readEnv } from "@/lib/env";
export const POST = ledgerRoute(
  async (request, { db, ownerId, id }) =>
    saveCsvMapping(db, ownerId, id!, await ledgerBody(request), readEnv()),
  true,
);
