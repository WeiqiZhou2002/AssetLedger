import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { getSettings, updateSettings } from "@/lib/ledger/settings";
export const GET = ledgerRoute(async (_, { db, ownerId }) => getSettings(db, ownerId));
export const PATCH = ledgerRoute(
  async (request, { db, ownerId }) => updateSettings(db, ownerId, await ledgerBody(request)),
  true,
);
