import { z } from "zod";
import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { entrySchema } from "@/lib/ledger/schemas";
import { replaceEntry } from "@/lib/ledger/entries";
export const POST = ledgerRoute(async (request, { db, ownerId, id }) => {
  const body = z
    .object({ reason: z.string().trim().min(1).max(2000), entry: entrySchema })
    .strict()
    .parse(await ledgerBody(request));
  return replaceEntry(db, ownerId, id!, body.entry, body.reason);
}, true);
