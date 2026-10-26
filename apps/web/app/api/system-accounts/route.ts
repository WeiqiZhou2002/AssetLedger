import { z } from "zod";
import { ledgerBody, ledgerRoute } from "@/lib/ledger/http";
import { getSystemAccount } from "@/lib/ledger/accounts";
import { systemTypes } from "@/lib/ledger/constants";
import { currencySchema } from "@/lib/ledger/schemas";
export const POST = ledgerRoute(async (request, { db, ownerId }) => {
  const { type, currency } = z
    .object({ type: z.enum(systemTypes), currency: currencySchema })
    .strict()
    .parse(await ledgerBody(request));
  return getSystemAccount(db, ownerId, type, currency);
}, true);
