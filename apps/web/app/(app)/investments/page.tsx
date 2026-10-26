import { PageHeading } from "@/components/page-heading";
import { InvestmentsView } from "@/components/dashboard/investments-view";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/db/client";
import { readEnv } from "@/lib/env";
import { todayInTimezone } from "@/lib/ledger/format";
import { snapshotAnalytics } from "@/lib/snapshots/analytics";
export const metadata = { title: "投资" };
export default async function InvestmentsPage() {
  const user = await requireUser();
  const today = todayInTimezone(user.timezone);
  const env = readEnv();
  const data = await snapshotAnalytics(getDb(), user.id, today, env.STALE_ACCOUNT_DAYS);
  return (
    <>
      <PageHeading
        eyebrow="INVESTMENTS"
        title="投资"
        description="把市值变化与净投入分开，让资产全貌保持清晰。"
      />
      <InvestmentsView rows={data.investments} today={today} />
    </>
  );
}
