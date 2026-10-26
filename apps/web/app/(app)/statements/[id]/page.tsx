import { accountBalanceTracking } from "@/lib/ledger/balance-tracking";
import { todayInTimezone } from "@/lib/ledger/format";
import { statementRewardsPreview } from "@/lib/rewards/integrations";
import { jsonSafe } from "@/lib/serialization";
import { z } from "zod";
import { notFound } from "next/navigation";
import { StatementReviewView } from "@/components/imports/review-view";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/db/client";
import { listAccounts } from "@/lib/ledger/accounts";
import { listCategories } from "@/lib/ledger/categories";
import { getStatementReview } from "@/lib/imports/service";
import { aiPreview } from "@/lib/imports/ai";
import { LedgerError } from "@/lib/ledger/errors";
import { readEnv } from "@/lib/env";
export const metadata = { title: "审核账单" };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const parsed = z.uuid().safeParse((await params).id);
  if (!parsed.success) notFound();
  const db = getDb();
  const [data, accounts, categories, ai, rewards, tracking] = await Promise.all([
    getStatementReview(db, user.id, parsed.data),
    listAccounts(db, user.id),
    listCategories(db, user.id),
    aiPreview(db, user.id, parsed.data, readEnv()),
    statementRewardsPreview(db, user.id, parsed.data),
    accountBalanceTracking(db, user.id, todayInTimezone(user.timezone)),
  ]).catch((error: unknown) => {
    if (error instanceof LedgerError && error.status === 404) notFound();
    throw error;
  });
  return (
    <StatementReviewView
      data={data}
      manualAccountIds={tracking.filter((row) => row.manual).map((row) => row.accountId)}
      accounts={accounts}
      categories={categories}
      ai={ai}
      rewards={jsonSafe(rewards)}
    />
  );
}
