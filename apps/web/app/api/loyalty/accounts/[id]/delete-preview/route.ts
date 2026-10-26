import { ledgerRoute } from "@/lib/ledger/http";
import { previewLoyaltyAccountDelete } from "@/lib/rewards/delete";
export const GET = ledgerRoute(async (_request, { db, ownerId, id }) =>
  previewLoyaltyAccountDelete(db, ownerId, id!),
);
