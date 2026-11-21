import { setBenefitAssignment } from "@/lib/benefits/assignment-service";
import { ledgerBody, ledgerRoute } from "@/lib/ledger/http";
export const PUT = ledgerRoute(
  async (request, { db, ownerId }) => setBenefitAssignment(db, ownerId, await ledgerBody(request)),
  true,
);
