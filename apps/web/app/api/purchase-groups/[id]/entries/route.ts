import { z } from "zod";
import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { linkGroupEntry } from "@/lib/ledger/purchase-groups";
const schema = z.object({ entryId: z.uuid() }).strict();
export const POST = ledgerRoute(async (request, { db, ownerId, id }) => {
  await linkGroupEntry(db, ownerId, id!, schema.parse(await ledgerBody(request)).entryId);
  return { ok: true };
}, true);
export const DELETE = ledgerRoute(async (request, { db, ownerId, id }) => {
  await linkGroupEntry(db, ownerId, id!, schema.parse(await ledgerBody(request)).entryId, true);
  return { ok: true };
}, true);
