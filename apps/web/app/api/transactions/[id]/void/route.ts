import { z } from "zod";
import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { voidEntry } from "@/lib/ledger/entries";
export const POST = ledgerRoute(async (request, { db, ownerId, id }) => {
  const body = z
    .object({ reason: z.string().trim().min(1).max(2000) })
    .strict()
    .parse(await ledgerBody(request));
  return voidEntry(db, ownerId, id!, body.reason);
}, true);
