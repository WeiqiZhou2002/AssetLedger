import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { saveProgram } from "@/lib/rewards/service";
export const PATCH = ledgerRoute(
  async (request, { db, ownerId, id }) => saveProgram(db, ownerId, await ledgerBody(request), id!),
  true,
);
