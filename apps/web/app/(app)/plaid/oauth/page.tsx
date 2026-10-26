import { notFound } from "next/navigation";
import { loadPlaidConfig } from "@/lib/bank-sync/config";
import { getDb } from "@/db/client";
import { requireUser } from "@/lib/auth/current-user";
import { OAuthReturn } from "@/components/bank-sync/link";
export default async function PlaidOAuth() {
  const user = await requireUser();
  const { config } = await loadPlaidConfig(getDb(), user.id);
  if (config.PLAID_ENABLED !== "true") notFound();
  return <OAuthReturn />;
}
