import type { NextRequest } from "next/server";
import { readEnv } from "@/lib/env";
import { json } from "@/lib/auth/http";
import { ledgerRoute, type LedgerContext } from "@/lib/ledger/http";
import { PlaidClient, plaidError } from "./plaid-client";
import type { BankClient, PlaidConfig } from "./types";
export function plaidRoute(
  handler: (
    request: NextRequest,
    context: LedgerContext & { client: BankClient; config: PlaidConfig },
  ) => Promise<unknown>,
  mutating = false,
) {
  return async (request: NextRequest, context?: { params: Promise<{ id?: string }> }) => {
    const config = readEnv();
    if (config.PLAID_ENABLED !== "true") return json({ error: "未找到" }, 404);
    return ledgerRoute(async (request, ctx) => {
      try {
        return await handler(request, { ...ctx, client: new PlaidClient(config), config });
      } catch (error) {
        const safe = plaidError(error);
        if (safe.errorCode !== "PLAID_REQUEST_FAILED") {
          console.error(JSON.stringify({ request_id: safe.requestId, error_code: safe.errorCode }));
          return json(
            {
              error:
                safe.errorCode === "ITEM_LOGIN_REQUIRED"
                  ? "银行需要重新授权"
                  : "Plaid 请求未完成，请稍后重试",
              errorCode: safe.errorCode,
              requestId: safe.requestId,
            },
            502,
          );
        }
        throw error;
      }
    }, mutating)(request, context);
  };
}
