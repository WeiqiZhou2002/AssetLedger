import { z } from "zod";
import { getEntry } from "@/lib/ledger/entries";
import { getDb } from "@/db/client";
import { requireUser } from "@/lib/auth/current-user";
import { listAccounts } from "@/lib/ledger/accounts";
import { listCategories } from "@/lib/ledger/categories";
import { listEntries } from "@/lib/ledger/queries";
import { listPurchaseGroups } from "@/lib/ledger/purchase-groups";
import { getSettings } from "@/lib/ledger/settings";
import { todayInTimezone } from "@/lib/ledger/format";
import { filtersSchema } from "@/lib/ledger/schemas";
import { PageHeading } from "@/components/page-heading";
import { ActivityView } from "@/components/ledger/activity-view";
export const metadata = { title: "每日流水" };
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const db = getDb();
  const params = Object.fromEntries(
    Object.entries(await searchParams).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1]),
    ),
  );
  const detailId = z.uuid().safeParse(params.entryId);
  delete params.entryId;
  const initialEntry = detailId.success ? await getEntry(db, user.id, detailId.data).catch(() => null) : null;
  const settings = await getSettings(db, user.id);
  const parsed = filtersSchema.safeParse({ basis: settings.spendingDateBasis, ...params });
  const filters = parsed.success ? parsed.data : filtersSchema.parse({ basis: settings.spendingDateBasis });
  const [data, accounts, categories, groups] = await Promise.all([
    listEntries(db, user.id, filters),
    listAccounts(db, user.id, true),
    listCategories(db, user.id),
    listPurchaseGroups(db, user.id),
  ]);
  return (
    <>
      <PageHeading eyebrow="DAILY ACTIVITY" title="每日流水" description="每一笔真实交易，都有自己的去向。" />
      {!parsed.success ? (
        <p role="alert" className="mb-4 text-sm text-destructive">
          筛选条件无效，已显示默认范围。
        </p>
      ) : null}
      <ActivityView
        key={initialEntry?.id ?? "activity"}
        initialEntry={initialEntry}
        data={data}
        accounts={accounts}
        categories={categories}
        groups={groups}
        today={todayInTimezone(user.timezone)}
        settings={settings}
        filters={parsed.success ? params : {}}
      />
    </>
  );
}
