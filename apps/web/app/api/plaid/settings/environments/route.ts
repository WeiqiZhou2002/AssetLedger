import { ledgerRoute } from "@/lib/ledger/http";
import { connectionEnvironments } from "@/lib/bank-sync/settings";
export const GET = ledgerRoute(async (_request, { db, ownerId }) => connectionEnvironments(db, ownerId));
