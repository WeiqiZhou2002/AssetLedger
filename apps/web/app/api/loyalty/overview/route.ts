import { ledgerRoute } from "@/lib/ledger/http";
import { rewardsOverview } from "@/lib/rewards/queries";
export const GET = ledgerRoute(async (request, { db, ownerId }) =>
  rewardsOverview(
    db,
    ownerId,
    request.nextUrl.searchParams.get("asOf") ?? new Date().toISOString().slice(0, 10),
  ),
);
