import { getDb } from "@/db/client";
import { readEnv } from "@/lib/env";
import { receivePlaidWebhook } from "@/lib/bank-sync/webhook";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return receivePlaidWebhook(getDb(), request, readEnv());
}
