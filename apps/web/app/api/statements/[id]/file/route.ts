import { ledgerRoute } from "@/lib/ledger/http";
import { deleteStatementFile } from "@/lib/imports/evidence";
import { readEnv } from "@/lib/env";
export const DELETE = ledgerRoute(
  async (request, { db, ownerId, id }) =>
    deleteStatementFile(db, ownerId, id!, readEnv(), request.nextUrl.searchParams.get("discard") === "true"),
  true,
);
