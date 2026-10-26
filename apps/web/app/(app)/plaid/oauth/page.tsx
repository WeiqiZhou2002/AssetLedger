import { notFound } from "next/navigation";
import { readEnv } from "@/lib/env";
import { OAuthReturn } from "@/components/bank-sync/link";
export default function PlaidOAuth() {
  if (readEnv().PLAID_ENABLED !== "true") notFound();
  return <OAuthReturn />;
}
