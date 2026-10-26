import { BrandLogo } from "@/components/brand-logo";
import { LoginForm } from "@/components/login-form";
import { getDb } from "@/db/client";
import { hasUsers } from "@/lib/auth/setup";
export const metadata = { title: "登录" };
export const dynamic = "force-dynamic";
export default async function Login() {
  const ready = await hasUsers(getDb());
  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <section className="hidden flex-col justify-between bg-primary p-14 text-primary-foreground lg:flex">
        <div className="flex items-center gap-3 text-lg font-medium">
          <BrandLogo size={40} />
          Asset Ledger
        </div>
        <div className="max-w-lg">
          <p className="eyebrow mb-7 text-primary-foreground/60">A CLEARER VIEW OF YOUR EVERYDAY</p>
          <h1 className="text-5xl leading-[1.4] font-medium tracking-tight">
            生活有来有往，
            <br />
            每一笔都清楚。
          </h1>
          <p className="mt-7 max-w-sm text-sm leading-8 text-primary-foreground/65">
            收拢分散的账户与账单，
            <br />
            给资产的每一次变化，留下一份清晰记录。
          </p>
          <div className="mt-12 h-px w-16 bg-[#b8cc9d]" />
        </div>
        <p className="text-xs tracking-wider text-primary-foreground/55">
          PRIVATE BY DESIGN · 你的数据，由你保管
        </p>
      </section>
      <section className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-10 flex items-center gap-3 font-semibold text-primary">
            <BrandLogo size={48} />
            Asset Ledger
          </div>
          <p className="eyebrow mb-4">WELCOME BACK</p>
          <h2 className="text-3xl font-semibold tracking-tight">打开你的私人账簿</h2>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">登录，继续整理你的财务日常。</p>
          {ready ? (
            <LoginForm />
          ) : (
            <div className="mt-8 space-y-3 rounded-lg border p-4 text-sm leading-7">
              <p className="font-medium">尚未完成首次设置</p>
              <p>
                请运行 <code>scripts/setup.sh</code>，使用脚本打开的链接完成设置。
              </p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
