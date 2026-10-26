import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { listAccounts, createAccount } from "@/lib/ledger/accounts";
export const GET = ledgerRoute(async (_, { db, ownerId }) => ({ accounts: await listAccounts(db, ownerId) }));
export const POST = ledgerRoute(
  async (request, { db, ownerId }) => createAccount(db, ownerId, await ledgerBody(request)),
  true,
);
