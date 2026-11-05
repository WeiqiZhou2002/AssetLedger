import Link from "next/link";
import { getDb } from "@/db/client";
import { requireUser } from "@/lib/auth/current-user";
import { readEnv } from "@/lib/env";
import { connectionEnvironments, publicPlaidSettings } from "@/lib/bank-sync/settings";
import { PageHeading } from "@/components/page-heading";
import { PlaidSettingsForm } from "@/components/bank-sync/settings-form";
import { plaidWebhookUrl, usesHttpsWebhook } from "@/lib/bank-sync/webhook-url";
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
      <p className="mt-4 text-sm break-all text-muted-foreground">
        新账户通知：
        {usesHttpsWebhook(env.APP_URL) ? (
          <>
            实时接收，并在每次同步时核对 Plaid 通知记录
            <span className="mt-1 block">{plaidWebhookUrl(env.APP_URL)}</span>
          </>
        ) : (
          "每次同步时查询 Plaid 通知记录（本机地址无法实时接收）"
        )}
      </p>
      <Link href="/statements?tab=sync" className="mt-6 block text-sm text-primary underline">
        管理银行连接与同步 →
      </Link>
    </>
  );
}
