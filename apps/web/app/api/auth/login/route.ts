import { z } from "zod";
import { getDb } from "@/db/client";
import { loginPassword } from "@/lib/auth/login";
import { loginContext, loginResponse, mutation, readJson } from "@/lib/auth/http";
const input = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((v) => v.trim().toLowerCase()),
    password: z.string().min(1).max(1024),
  })
  .strict();
export const POST = mutation(async (request) => {
  const { email, password } = input.parse(await readJson(request));
  return loginResponse(await loginPassword(getDb(), email, password, loginContext(request)));
});
