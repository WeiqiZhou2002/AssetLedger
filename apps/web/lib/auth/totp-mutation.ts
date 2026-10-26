import { z } from "zod";
import { getDb } from "@/db/client";
import { readEnv } from "@/lib/env";
import { authenticated, json, loginContext, mutation, readJson } from "./http";
import { disableTotp, enableTotp } from "./totp";
import { limitedAttempt, rateKeys } from "./rate-limit";
import { SESSION_COOKIE, sessionCookieOptions } from "./session";
export function totpMutation(action: "enable" | "disable") {
  return mutation(async (request) => {
    const { user } = await authenticated(request);
    const { code } = z
      .object({ code: z.string().regex(/^\d{6}$/) })
      .strict()
      .parse(await readJson(request));
    const context = loginContext(request);
    const result = await limitedAttempt(
      getDb(),
      rateKeys(user.email, context.ip, context.appSecret),
      async (tx) => ({
        ok: await (action === "enable" ? enableTotp : disableTotp)(tx, user.id, code, context.appSecret),
      }),
    );
    if (!result.ok) return json({ error: "验证码无效、已使用或设置已过期，请稍后重试" }, 400);
    const response = json({ ok: true });
    if (action === "disable")
      response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(readEnv().APP_URL), maxAge: 0 });
    return response;
  });
}
