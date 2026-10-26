import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { statementRewardsPreview, confirmStatementRewards } from "@/lib/rewards/integrations";
export const GET = ledgerRoute(async (_request, { db, ownerId, id }) =>
  statementRewardsPreview(db, ownerId, id!),
);
export const POST = ledgerRoute(
  async (request, { db, ownerId, id }) =>
    confirmStatementRewards(db, ownerId, id!, await ledgerBody(request)),
  true,
);
