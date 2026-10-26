import Link from "next/link";
import { getDb } from "@/db/client";
import { requireUser } from "@/lib/auth/current-user";
import { readEnv } from "@/lib/env";
import { connectionEnvironments, publicPlaidSettings } from "@/lib/bank-sync/settings";
import { PageHeading } from "@/components/page-heading";
import { PlaidSettingsForm } from "@/components/bank-sync/settings-form";
export const metadata = { title: "银行连接" };
export default async function BankSettings() {
  const user = await requireUser();
  const db = getDb();
  const env = readEnv();
  const [settings, environments] = await Promise.all([
    publicPlaidSettings(db, user.id, env),
    connectionEnvironments(db, user.id),
  ]);
  return (
    <>
      <PageHeading
        eyebrow="BANK CONNECTIONS"
        title="银行连接"
        description="配置 Plaid 凭据，按需开启银行同步。"
      />
      <PlaidSettingsForm
        initial={settings}
        environments={environments}
        callbackUrl={`${env.APP_URL.replace(/\/$/, "")}/plaid/oauth`}
      />
      <Link href="/statements?tab=sync" className="mt-6 block text-sm text-primary underline">
        管理银行连接与同步 →
      </Link>
    </>
  );
}
