import { plaidRoute } from "@/lib/bank-sync/http";
import { createLinkToken } from "@/lib/bank-sync/connections";
import { ledgerBody } from "@/lib/ledger/http";
import { z } from "zod";
export const POST = plaidRoute(async (request, { db, ownerId, client, config }) => {
  const { product } = z
    .object({ product: z.enum(["transactions", "investments"]) })
    .strict()
    .parse(await ledgerBody(request));
  return createLinkToken(db, ownerId, client, config, product);
}, true);
