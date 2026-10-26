import { ledgerRoute } from "@/lib/ledger/http";
import { confirmEntry } from "@/lib/ledger/entries";
export const POST = ledgerRoute(async (_, { db, ownerId, id }) => confirmEntry(db, ownerId, id!), true);
