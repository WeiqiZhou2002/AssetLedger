import { BenefitOverview } from "@/components/benefits/overview";
import { PageHeading } from "@/components/page-heading";
import { getDb } from "@/db/client";
import { requireUser } from "@/lib/auth/current-user";
import { benefitOverview } from "@/lib/benefits/queries";
import { todayInTimezone } from "@/lib/ledger/format";
export const metadata = { title: "卡权益" };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const today = todayInTimezone(user.timezone);
  const year =
    typeof params.year === "string" && /^\d{4}$/.test(params.year) ? params.year : today.slice(0, 4);
  const data = await benefitOverview(getDb(), user.id, today, year);
  return (
    <>
      <PageHeading
        eyebrow="CARD BENEFITS"
        title="卡权益返还"
        description="记录每张卡的权益返还，按年份查看使用情况。"
      />
      <BenefitOverview data={data} />
    </>
  );
}
