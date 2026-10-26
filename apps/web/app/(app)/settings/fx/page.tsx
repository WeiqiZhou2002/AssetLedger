import { PageHeading } from "@/components/page-heading";
import { FxManager } from "@/components/snapshots/fx-manager";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/db/client";
import { readEnv } from "@/lib/env";
import { listFxRates } from "@/lib/snapshots/fx";
import { todayInTimezone } from "@/lib/ledger/format";
export const metadata = { title: "汇率" };
export default async function FxPage() {
  const user = await requireUser();
  return (
    <>
      <PageHeading
        eyebrow="EXCHANGE RATES"
        title="汇率"
        description="保留观察日期，让不同币种的换算有据可查。"
      />
      <FxManager
        rates={await listFxRates(getDb(), user.id)}
        today={todayInTimezone(user.timezone)}
        baseCurrency={user.baseCurrency}
        staleDays={readEnv().FX_STALE_DAYS}
      />
    </>
  );
}
