import { ledgerBody, ledgerRoute } from "@/lib/ledger/http";
import { deleteCard, saveCard } from "@/lib/ledger/card-secrets";
import { readEnv } from "@/lib/env";
export const PUT = ledgerRoute(
  async (request, { db, ownerId, id }) =>
    saveCard(db, ownerId, id!, await ledgerBody(request), readEnv().APP_SECRET),
  true,
);
export const DELETE = ledgerRoute(async (_, { db, ownerId, id }) => deleteCard(db, ownerId, id!), true);
