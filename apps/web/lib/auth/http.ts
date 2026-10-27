import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { jsonSafe } from "@/lib/serialization";
import { readEnv } from "@/lib/env";
import { getDb } from "@/db/client";
import { SESSION_COOKIE, sessionCookieOptions, validateSession } from "./session";
import { CHALLENGE_COOKIE } from "./challenge";
import { clientIp, RateLimitError } from "./rate-limit";
import type { LoginResult } from "./login";
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];
// A loopback origin also accepts the other loopback names on the same scheme and port.
function originVariants(value: string) {
  const expected = new URL(value);
  if (!LOOPBACK_HOSTNAMES.includes(expected.hostname)) return [expected];
  return LOOPBACK_HOSTNAMES.map((hostname) => {
    const variant = new URL(expected);
    variant.hostname = hostname;
    return variant;
  });
}
export function assertOrigin(request: Request, appUrl: string, extraOrigins = "") {
  const allowed = [
    appUrl,
    ...extraOrigins
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ].flatMap(originVariants);
  const matches = allowed.some(
    (expected) =>
      request.headers.get("origin") === expected.origin && request.headers.get("host") === expected.host,
  );
  if (!matches) {
    throw new HttpError(403, "请求来源无效，请从本站重新操作");
  }
}
export function json(body: unknown, status = 200) {
  return NextResponse.json(jsonSafe(body), { status, headers: { "Cache-Control": "no-store" } });
}
export function mutation(handler: (request: NextRequest) => Promise<NextResponse>) {
  return async (request: NextRequest) => {
    try {
      const env = readEnv();
      assertOrigin(request, env.APP_URL, env.EXTRA_ALLOWED_ORIGINS);
      return await handler(request);
    } catch (error) {
      if (error instanceof RateLimitError) {
        const response = json({ error: error.message }, 429);
        response.headers.set("Retry-After", "900");
        return response;
      }
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return json({ error: "输入格式无效，请检查后重试" }, 400);
      console.error(JSON.stringify({ kind: "auth_request_failed" }));
      return json({ error: "服务暂不可用，请稍后重试" }, 503);
    }
  };
}
export async function readJson(request: Request, maxBytes = 8192): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new HttpError(415, "请使用 JSON 请求");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "请求内容为空");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "请求内容过长");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function loginContext(request: NextRequest) {
  const env = readEnv();
  return {
    appSecret: env.APP_SECRET,
    ip: clientIp(request.headers, env.TRUST_CLOUDFLARE_HEADERS === "true"),
    userAgent: request.headers.get("user-agent") ?? "",
    oldToken: request.cookies.get(SESSION_COOKIE)?.value,
  };
}
export async function authenticated(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const result = await validateSession(getDb(), token);
  if (!result || !token) throw new HttpError(401, "登录已过期，请重新登录");
  return { ...result, token };
}
export function loginResponse(result: LoginResult) {
  if (!result.ok) return json({ error: "邮箱、密码或验证码不正确，或验证已过期" }, 401);
  const options = sessionCookieOptions(readEnv().APP_URL);
  if ("challenge" in result) {
    const response = json({ totpRequired: true });
    response.cookies.set(CHALLENGE_COOKIE, result.challenge, { ...options, maxAge: 300 });
    return response;
  }
  const response = json({ ok: true });
  response.cookies.set(SESSION_COOKIE, result.token, { ...options, expires: result.expiresAt });
  response.cookies.set(CHALLENGE_COOKIE, "", { ...options, maxAge: 0 });
  return response;
}
