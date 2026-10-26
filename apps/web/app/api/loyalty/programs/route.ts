import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { listPrograms, saveProgram } from "@/lib/rewards/service";
export const GET = ledgerRoute(async (_request, { db, ownerId }) => listPrograms(db, ownerId));
export const POST = ledgerRoute(
  async (request, { db, ownerId }) => saveProgram(db, ownerId, await ledgerBody(request)),
  true,
);
