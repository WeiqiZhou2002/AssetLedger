import Link from "next/link";
import { PageHeading } from "@/components/page-heading";
import { RewardsView } from "@/components/rewards/view";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/db/client";
import { rewardsOverview } from "@/lib/rewards/queries";
import { listAccounts } from "@/lib/ledger/accounts";
import { dateSchema } from "@/lib/ledger/schemas";
import { todayInTimezone } from "@/lib/ledger/format";
export const metadata = { title: "积分里程" };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const parsed = dateSchema.safeParse(params.asOf);
  const asOf = parsed.success ? parsed.data : todayInTimezone(user.timezone);
  const [data, cards] = await Promise.all([
    rewardsOverview(getDb(), user.id, asOf),
    listAccounts(getDb(), user.id),
  ]);
  return (
    <>
      <PageHeading
        eyebrow="POINTS & MILES"
        title="让每一点，都有来处。"
        description="独立记录点数与里程；按你的使用习惯，保留每一次估值。"
      />
      <Link href="/benefits" className="mb-6 inline-block text-sm text-primary">
        查看卡权益返还 →
      </Link>
      <RewardsView
        data={data}
        cards={cards
          .filter((row) => row.type === "liability_credit_card")
          .map((row) => ({ id: row.id, name: row.name }))}
      />
    </>
  );
}
