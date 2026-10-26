import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { listInstitutions, createInstitution } from "@/lib/ledger/accounts";
export const GET = ledgerRoute(async (_, { db, ownerId }) => ({
  institutions: await listInstitutions(db, ownerId),
}));
export const POST = ledgerRoute(
  async (request, { db, ownerId }) => createInstitution(db, ownerId, await ledgerBody(request)),
  true,
);
