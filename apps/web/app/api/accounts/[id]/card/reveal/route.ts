import { ledgerBody, ledgerRoute } from "@/lib/ledger/http";
import { revealCard } from "@/lib/ledger/card-secrets";
import { json, loginContext } from "@/lib/auth/http";
import { RateLimitError } from "@/lib/auth/rate-limit";
export const POST = ledgerRoute(async (request, { db, ownerId, id }) => {
  try {
    return await revealCard(db, ownerId, id!, await ledgerBody(request), loginContext(request));
  } catch (error) {
    if (!(error instanceof RateLimitError)) throw error;
    const response = json({ error: error.message }, 429);
    response.headers.set("Retry-After", "900");
    return response;
  }
}, true);
