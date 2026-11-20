import { setBenefitMark } from "@/lib/benefits/mark-service";
import { ledgerBody, ledgerRoute } from "@/lib/ledger/http";
export const PUT = ledgerRoute(
  async (request, { db, ownerId }) => setBenefitMark(db, ownerId, await ledgerBody(request)),
  true,
);
