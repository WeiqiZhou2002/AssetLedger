import { z } from "zod";
import { readOptionalJson } from "@/lib/auth/http";

export async function readAccountSelection(request: Request) {
  const body = await readOptionalJson(request);
  return z
    .object({ accountSelection: z.boolean().optional() })
    .strict()
    .parse(body === undefined ? {} : body);
}
