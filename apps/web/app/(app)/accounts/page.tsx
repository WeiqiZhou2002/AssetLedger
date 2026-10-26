import { accountBalanceTracking } from "@/lib/ledger/balance-tracking";
import { listFxRates } from "@/lib/snapshots/fx";
import { accountPositions } from "@/lib/ledger/observed-balances";
import { benefitOverview } from "@/lib/benefits/queries";
import { listAccountGroups } from "@/lib/snapshots/groups";
import { PageHeading } from "@/components/page-heading";
import { AccountsView } from "@/components/ledger/accounts-view";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/db/client";
import { listInstitutions } from "@/lib/ledger/accounts";
import { cardMeta } from "@/lib/ledger/card-secrets";
import { balancesAsOf } from "@/lib/ledger/queries";
import { todayInTimezone } from "@/lib/ledger/format";
import { readEnv } from "@/lib/env";
import { BankConnectButton } from "@/components/bank-sync/connect-button";
export const metadata = { title: "账户" };
export default async function AccountsPage() {
  const user = await requireUser();
  const today = todayInTimezone(user.timezone);
  const db = getDb();
  const env = readEnv();
  const [accounts, institutions, groups, benefits, positions, cards, tracking, rates] = await Promise.all([
    balancesAsOf(db, user.id, today),
    listInstitutions(db, user.id),
    listAccountGroups(db, user.id),
    benefitOverview(db, user.id, today),
    accountPositions(db, user.id, today, { includeSuggestions: false }),
    cardMeta(db, user.id),
    accountBalanceTracking(db, user.id, today),
    listFxRates(db, user.id),
  ]);
  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <PageHeading eyebrow="ACCOUNTS" title="账户" description="查看最新余额，点击账户管理详情。" />
        {env.PLAID_ENABLED === "true" ? <BankConnectButton environment={env.PLAID_ENV} /> : null}
      </div>
      <AccountsView
        accounts={accounts.filter((account) => !account.isSystem)}
        institutions={institutions}
        groups={groups}
        today={today}
        tracking={tracking}
        rates={rates}
        baseCurrency={user.baseCurrency}
        syncIntervalHours={env.PLAID_SYNC_INTERVAL_HOURS}
        positions={positions.map(({ account, observed, difference }) => ({
          accountId: account.id,
          observed,
          difference,
        }))}
        timezone={user.timezone}
        cards={cards}
        totpEnabled={Boolean(user.totpEnabledAt)}
        benefits={benefits.cards.map(({ accountId, annual, rolling }) => ({ accountId, annual, rolling }))}
      />
    </>
  );
}
