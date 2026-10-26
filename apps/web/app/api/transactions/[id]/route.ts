import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { getEntry, updateEntryMeta } from "@/lib/ledger/entries";
export const GET = ledgerRoute(async (_, { db, ownerId, id }) => getEntry(db, ownerId, id!));
export const PATCH = ledgerRoute(
  async (request, { db, ownerId, id }) => updateEntryMeta(db, ownerId, id!, await ledgerBody(request)),
  true,
);
