import { z } from "zod";
import { readJson } from "@/lib/auth/http";

export async function readAccountSelection(request: Request) {
  return z
    .object({ accountSelection: z.boolean().optional() })
    .strict()
    .parse(request.body ? await readJson(request) : {});
}
