import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { listLoyaltyAccounts, saveLoyaltyAccount } from "@/lib/rewards/service";
export const GET = ledgerRoute(async (_request, { db, ownerId }) => listLoyaltyAccounts(db, ownerId));
export const POST = ledgerRoute(
  async (request, { db, ownerId }) => saveLoyaltyAccount(db, ownerId, await ledgerBody(request)),
  true,
);
