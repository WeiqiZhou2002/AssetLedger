import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { aiPreview, consentToAi } from "@/lib/imports/ai";
import { readEnv } from "@/lib/env";
export const GET = ledgerRoute(async (_request, { db, ownerId, id }) =>
  aiPreview(db, ownerId, id!, readEnv()),
);
export const POST = ledgerRoute(
  async (request, { db, ownerId, id }) => consentToAi(db, ownerId, id!, await ledgerBody(request), readEnv()),
  true,
);
