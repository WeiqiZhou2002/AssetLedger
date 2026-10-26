import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { updateCategory, deleteCategory } from "@/lib/ledger/categories";
export const PATCH = ledgerRoute(
  async (request, { db, ownerId, id }) => updateCategory(db, ownerId, id!, await ledgerBody(request)),
  true,
);

export const DELETE = ledgerRoute(async (_, { db, ownerId, id }) => {
  await deleteCategory(db, ownerId, id!);
  return { ok: true };
}, true);
