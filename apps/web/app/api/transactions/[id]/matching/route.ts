import { ledgerBody, ledgerRoute } from "@/lib/ledger/http";
import { entryMatching, resolveEntryMatching } from "@/lib/bank-sync/matching";
export const GET = ledgerRoute(async (_, { db, ownerId, id }) => entryMatching(db, ownerId, id!));
export const POST = ledgerRoute(
  async (request, { db, ownerId, id }) => resolveEntryMatching(db, ownerId, id!, await ledgerBody(request)),
  true,
);
