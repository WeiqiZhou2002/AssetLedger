import { requireUser } from "@/lib/auth/current-user";
import { AppNavigation } from "@/components/app-navigation";
import { LogoutButton } from "@/components/logout-button";
import { readEnv } from "@/lib/env";
import { getDb } from "@/db/client";
import { pendingCount } from "@/lib/bank-sync/pending";
import { transferSuggestions } from "@/lib/bank-sync/transfer-suggestions";
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const env = readEnv();
  const plaidEnabled = env.PLAID_ENABLED === "true";
  const pending = plaidEnabled
    ? await pendingCount(getDb(), user.id, env.PLAID_ENV)
    : (await transferSuggestions(getDb(), user.id)).length;
  return (
    <div className="min-h-dvh">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:z-50 focus:bg-card focus:p-4"
      >
        跳到主要内容
      </a>
      <AppNavigation plaidEnabled={plaidEnabled} pendingCount={pending} />
      <div className="lg:pl-60">
        <div className="mx-auto flex max-w-7xl items-center justify-end px-5 pt-4 sm:px-10">
          <LogoutButton />
        </div>
        <main id="main-content" className="mx-auto max-w-7xl px-5 pt-6 pb-28 sm:px-10 lg:pt-10 lg:pb-12">
          {children}
        </main>
      </div>
    </div>
  );
}
