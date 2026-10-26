import { getDb } from "@/db/client";
import { readEnv } from "@/lib/env";
import { authenticated, json, mutation } from "@/lib/auth/http";
import { logout, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";
import { CHALLENGE_COOKIE } from "@/lib/auth/challenge";
import { auditAuth } from "@/lib/auth/audit";
export const POST = mutation(async (request) => {
  const { user, token } = await authenticated(request);
  await getDb().transaction(async (tx) => {
    await logout(tx, user.id, token);
    await auditAuth(tx, user.id, "session.logout");
  });
  const response = json({ ok: true });
  for (const name of [SESSION_COOKIE, CHALLENGE_COOKIE])
    response.cookies.set(name, "", { ...sessionCookieOptions(readEnv().APP_URL), maxAge: 0 });
  return response;
});
