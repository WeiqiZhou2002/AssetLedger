import { accountBalanceTracking } from "@/lib/ledger/balance-tracking";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/db/client";
import { readEnv } from "@/lib/env";
import { getSettings } from "@/lib/ledger/settings";
import { todayInTimezone } from "@/lib/ledger/format";
import { wealthOverview } from "./wealth";
import { monthSummary, monthWindow } from "./month";
import { monthActivity } from "./activity";
import { loadBackcast } from "./backcast";
import { historyStart, shiftDate } from "@/lib/bank-sync/date-range";
export async function loadDashboard(
  params: Record<string, string | string[] | undefined>,
  entryView?: "spending" | "income",
) {
  const user = await requireUser();
  const db = getDb();
  const env = readEnv();
  const today = todayInTimezone(user.timezone);
  const settings = await getSettings(db, user.id);
  const basis =
    params.basis === "event" || params.basis === "posted" ? params.basis : settings.spendingDateBasis;
  const start = historyStart(env, today);
  const from = [start, shiftDate(today, -89)].sort()[0];
  const window = monthWindow(params.month, today);
  const [backcast, wealth, month, tracking, activity] = await Promise.all([
    loadBackcast(db, user.id, { from, to: today, baseCurrency: user.baseCurrency }),
    wealthOverview(db, user.id, today, user.baseCurrency, env.STALE_ACCOUNT_DAYS, env.FX_STALE_DAYS),
    monthSummary(db, user.id, params.month, today, basis, user.baseCurrency, env.FX_STALE_DAYS),
    accountBalanceTracking(db, user.id, today),
    entryView ? monthActivity(db, user.id, { ...window, basis }, entryView) : undefined,
  ]);
  return {
    wealth,
    month,
    activity,
    dueBalanceCount: tracking.filter((row) => row.reminderDue).length,
    backcast: { ...backcast, historyStart: start },
  };
}
