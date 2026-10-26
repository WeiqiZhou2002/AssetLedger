import { plaidRoute } from "@/lib/bank-sync/http";
import { createLatestSyncDraft } from "@/lib/bank-sync/observations";
export const POST = plaidRoute(async (_request, { db, ownerId }) => createLatestSyncDraft(db, ownerId), true);
