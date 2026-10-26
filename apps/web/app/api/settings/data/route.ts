import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { deleteOwnerData } from "@/lib/data/delete";
import { readEnv } from "@/lib/env";
import { json } from "@/lib/auth/http";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";
export const DELETE = ledgerRoute(async (request, { db, ownerId }) => {
  const env = readEnv();
  const result = await deleteOwnerData(db, ownerId, await ledgerBody(request), env);
  const response = json(result);
  response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(env.APP_URL), maxAge: 0 });
  return response;
}, true);
