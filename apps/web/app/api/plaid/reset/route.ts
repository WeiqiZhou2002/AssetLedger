import { z } from "zod";
import { ledgerBody } from "@/lib/ledger/http";
import { resetRoute } from "@/lib/bank-sync/reset-http";
import { executeReset, planReset } from "@/lib/bank-sync/reset";
import { resetInput } from "@/lib/bank-sync/reset-types";
const requestSchema = resetInput.extend({
  execute: z.boolean().default(false),
  confirmation: z.string().optional(),
});
export const POST = resetRoute(async (request, { db, ownerId, config }) => {
  const { execute, confirmation, ...input } = requestSchema.parse(await ledgerBody(request));
  if (execute) {
    z.literal("重置").parse(confirmation);
    return executeReset(db, ownerId, config, input);
  }
  return planReset(db, ownerId, config, input);
}, true);
