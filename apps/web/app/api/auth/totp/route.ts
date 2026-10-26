import { z } from "zod";
import { getDb } from "@/db/client";
import { CHALLENGE_COOKIE } from "@/lib/auth/challenge";
import { loginTotp } from "@/lib/auth/login";
import { loginContext, loginResponse, mutation, readJson } from "@/lib/auth/http";
export const POST = mutation(async (request) => {
  const { code } = z
    .object({ code: z.string().regex(/^\d{6}$/) })
    .strict()
    .parse(await readJson(request));
  return loginResponse(
    await loginTotp(getDb(), request.cookies.get(CHALLENGE_COOKIE)?.value, code, loginContext(request)),
  );
});
