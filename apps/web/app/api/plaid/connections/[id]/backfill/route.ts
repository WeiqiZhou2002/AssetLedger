import { plaidRoute } from "@/lib/bank-sync/http";
import { executeBackfill, planBackfill } from "@/lib/bank-sync/backfill";
export const POST = plaidRoute(async (request, { db, ownerId, config, id }) => {
  const { execute, ...input } = await request.json();
  return execute === true
    ? executeBackfill(db, ownerId, id!, config, input)
    : planBackfill(db, ownerId, id!, config, input);
}, true);
