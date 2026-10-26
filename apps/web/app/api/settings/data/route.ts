import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { deleteOwnerData } from "@/lib/data/delete";
import { loadPlaidConfig } from "@/lib/bank-sync/config";
import { json } from "@/lib/auth/http";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";
export const DELETE = ledgerRoute(async (request, { db, ownerId }) => {
  const { config: env } = await loadPlaidConfig(db, ownerId);
  const result = await deleteOwnerData(db, ownerId, await ledgerBody(request), env);
  const response = json(result);
  response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(env.APP_URL), maxAge: 0 });
  return response;
}, true);
