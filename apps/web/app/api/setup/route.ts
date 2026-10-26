import { getDb } from "@/db/client";
import { readEnv } from "@/lib/env";
import { json, loginContext, loginResponse, mutation, readJson } from "@/lib/auth/http";
import { completeSetup, hasUsers } from "@/lib/auth/setup";
export const POST = mutation(async (request) => {
  const db = getDb();
  if (await hasUsers(db)) return json({ error: "已完成首次设置，请登录" }, 409);
  const env = readEnv();
  const result = await completeSetup(db, await readJson(request), {
    ...loginContext(request),
    baseCurrency: env.BASE_CURRENCY,
    timezone: env.TZ,
  });
  return result.ok ? loginResponse(result) : json({ error: result.error }, result.status);
});
