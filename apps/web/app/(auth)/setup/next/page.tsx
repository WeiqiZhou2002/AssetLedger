import Link from "next/link";
import { requireUser } from "@/lib/auth/current-user";
import { BrandLogo } from "@/components/brand-logo";
export const metadata = { title: "设置完成" };
export default async function SetupNext() {
  await requireUser();
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-12">
      <div className="mb-10 flex items-center gap-3 font-semibold text-primary">
        <BrandLogo size={48} />
        Asset Ledger
      </div>
      <h1 className="text-3xl font-semibold">你的账簿已准备就绪</h1>
      <p className="mt-3 mb-8 text-sm leading-7 text-muted-foreground">
        先保护好账户，再按需连接银行。你也可以稍后在设置中完成。
      </p>
      <div className="space-y-4">
        {[
          ["/settings/security", "开启两步验证（推荐）", "用验证器为登录增加一道保护。"],
          ["/settings/banks", "填写 Plaid 凭据（可选）", "连接银行，自动同步账户和流水。"],
          ["/dashboard", "进入总览", "开始查看和整理你的私人账簿。"],
        ].map(([href, title, description]) => (
          <Link
            href={href}
            key={href}
            className="block rounded-xl border bg-card p-5 transition-colors hover:border-primary"
          >
            <h2 className="font-medium">{title} →</h2>
            <p className="mt-2 text-sm text-muted-foreground">{description}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}
