import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { hasUsers, SETUP_INVALID, validSetupToken } from "@/lib/auth/setup";
import { BrandLogo } from "@/components/brand-logo";
import { SetupForm } from "@/components/setup-form";
export const metadata = { title: "首次设置", referrer: "no-referrer" };
export const dynamic = "force-dynamic";
export default async function Setup({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const db = getDb();
  if (await hasUsers(db)) redirect("/login");
  const { token } = await searchParams;
  const valid = typeof token === "string" && (await validSetupToken(db, token));
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <section className="w-full max-w-md rounded-xl border bg-card p-6 sm:p-10">
        <div className="mb-10 flex items-center gap-3 font-semibold text-primary">
          <BrandLogo size={48} />
          Asset Ledger
        </div>
        <p className="eyebrow mb-4">WELCOME HOME</p>
        <h1 className="text-3xl font-semibold tracking-tight">设置你的私人账簿</h1>
        {valid ? (
          <>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">
              创建唯一的管理员，开始整理你的财务日常。
            </p>
            <SetupForm token={token!} />
          </>
        ) : (
          <div className="mt-6 space-y-4 text-sm leading-7">
            <p role="alert" className="text-destructive">
              {SETUP_INVALID}
            </p>
            <p>
              重新运行 <code>scripts/setup.sh</code>，或执行以下命令获取新链接：
            </p>
            <code className="block rounded-md bg-muted p-3 break-words">
              docker compose exec web node dist/admin.cjs --setup-link
            </code>
            <p>链接自生成起 24 小时内有效，请仅在自己的浏览器中打开。</p>
          </div>
        )}
      </section>
    </main>
  );
}
