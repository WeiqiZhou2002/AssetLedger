import { ledgerBody, ledgerRoute } from "@/lib/ledger/http";
import { benefitDetail, editBenefit } from "@/lib/benefits/service";
export const GET = ledgerRoute(async (_, { db, ownerId, id }) => benefitDetail(db, ownerId, id!));
export const POST = ledgerRoute(
  async (request, { db, ownerId, id }) => editBenefit(db, ownerId, id!, await ledgerBody(request)),
  true,
);
