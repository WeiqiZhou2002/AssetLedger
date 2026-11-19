import { setBenefitProfile } from "@/lib/benefits/profile";
import { ledgerBody, ledgerRoute } from "@/lib/ledger/http";
export const PUT = ledgerRoute(
  async (request, { db, ownerId }) => setBenefitProfile(db, ownerId, await ledgerBody(request)),
  true,
);
