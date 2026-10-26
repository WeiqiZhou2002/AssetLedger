import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { listCategories, createCategory } from "@/lib/ledger/categories";
export const GET = ledgerRoute(async (_, { db, ownerId }) => ({
  categories: await listCategories(db, ownerId),
}));
export const POST = ledgerRoute(
  async (request, { db, ownerId }) => createCategory(db, ownerId, await ledgerBody(request)),
  true,
);
