import { z } from "zod";
import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { entrySchema, quickSchema } from "@/lib/ledger/schemas";
import { createEntry } from "@/lib/ledger/entries";
import { createQuickEntry } from "@/lib/ledger/builders";
import { listEntries } from "@/lib/ledger/queries";
const schema = z.union([
  z.object({ mode: z.literal("quick"), input: quickSchema }).strict(),
  z.object({ mode: z.literal("advanced"), input: entrySchema }).strict(),
]);
export const GET = ledgerRoute(async (request, { db, ownerId }) =>
  listEntries(db, ownerId, Object.fromEntries(request.nextUrl.searchParams)),
);
export const POST = ledgerRoute(async (request, { db, ownerId }) => {
  const body = schema.parse(await ledgerBody(request));
  return body.mode === "quick"
    ? createQuickEntry(db, ownerId, body.input)
    : createEntry(db, ownerId, body.input);
}, true);
