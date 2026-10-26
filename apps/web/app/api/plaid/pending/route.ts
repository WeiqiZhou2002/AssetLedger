import { plaidRoute } from "@/lib/bank-sync/http";
import { pendingWorkbench, resolvePending } from "@/lib/bank-sync/pending";
import { ledgerBody } from "@/lib/ledger/http";
export const GET = plaidRoute(async (_request, { db, ownerId, config }) =>
  pendingWorkbench(db, ownerId, config.PLAID_ENV),
);
export const POST = plaidRoute(
  async (request, { db, ownerId, config }) => resolvePending(db, ownerId, config, await ledgerBody(request)),
  true,
);
