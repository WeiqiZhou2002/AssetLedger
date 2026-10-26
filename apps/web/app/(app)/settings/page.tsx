import Link from "next/link";
import { ArrowUpRight, ShieldCheck } from "lucide-react";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/db/client";
import { getSettings } from "@/lib/ledger/settings";
import { listCategories } from "@/lib/ledger/categories";
import { PageHeading } from "@/components/page-heading";
import { LedgerSettings } from "@/components/ledger/settings-view";
import { readEnv } from "@/lib/env";
export const metadata = { title: "设置" };
export default async function Settings() {
  const user = await requireUser();
  const db = getDb();
  const [settings, categories] = await Promise.all([getSettings(db, user.id), listCategories(db, user.id)]);
  return (
    <>
      <PageHeading eyebrow="PREFERENCES" title="设置" description="按你的习惯整理账簿，也保护好你的资料。" />
      <div className="mb-7 rounded-xl border bg-card p-5 sm:p-7">
        <dl className="space-y-4 text-sm">
          {[
            ["登录邮箱", user.email],
            ["基准货币", user.baseCurrency],
            ["时区", user.timezone],
          ].map(([label, value]) => (
            <div key={label} className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-all">{value}</dd>
            </div>
          ))}
        </dl>
        <Link
          href="/settings/security"
          className="mt-6 flex items-center gap-3 border-t pt-5 text-sm font-medium"
        >
          <ShieldCheck size={20} className="text-primary" />
          安全与两步验证
          <ArrowUpRight size={17} className="ml-auto" />
        </Link>
      </div>
      <Link
        href="/settings/fx"
        className="mb-7 flex items-center justify-between rounded-xl border bg-card p-5 text-sm font-medium"
      >
        汇率管理 <ArrowUpRight size={17} />
      </Link>
      <Link
        href="/settings/data"
        className="mb-7 flex items-center justify-between rounded-xl border bg-card p-5 text-sm font-medium"
      >
        数据导出、备份与删除 <ArrowUpRight size={17} />
      </Link>
      {readEnv().PLAID_ENABLED === "true" ? (
        <Link
          href="/statements?tab=sync"
          className="mb-7 flex items-center justify-between rounded-xl border bg-card p-5 text-sm font-medium"
        >
          银行连接 <ArrowUpRight size={17} />
        </Link>
      ) : null}
      <LedgerSettings settings={settings} categories={categories} />
    </>
  );
}
