import type { NextRequest } from "next/server";
import { readEnv } from "@/lib/env";
import { json } from "@/lib/auth/http";
import { ledgerRoute, type LedgerContext } from "@/lib/ledger/http";
import type { ResetConfig } from "./reset-types";
// Reset and recovery are local operations: do not instantiate a Plaid SDK client or require its keys.
export function resetRoute(
  handler: (request: NextRequest, context: LedgerContext & { config: ResetConfig }) => Promise<unknown>,
  mutating = false,
) {
  return async (request: NextRequest, context?: { params: Promise<{ id?: string }> }) => {
    const config = readEnv();
    if (config.PLAID_ENABLED !== "true") return json({ error: "未找到" }, 404);
    return ledgerRoute((request, ctx) => handler(request, { ...ctx, config }), mutating)(request, context);
  };
}
