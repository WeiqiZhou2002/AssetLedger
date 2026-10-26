import { ledgerBody, ledgerRoute } from "@/lib/ledger/http";
import { publicPlaidSettings, savePlaidSettings } from "@/lib/bank-sync/settings";
export const GET = ledgerRoute(async (_request, { db, ownerId }) => publicPlaidSettings(db, ownerId));
export const PUT = ledgerRoute(
  async (request, { db, ownerId }) => savePlaidSettings(db, ownerId, await ledgerBody(request)),
  true,
);
