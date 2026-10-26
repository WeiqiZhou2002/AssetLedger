import { requireUser } from "@/lib/auth/current-user";
import { PageHeading } from "@/components/page-heading";
import { DataSettings } from "@/components/rewards/data-settings";
import { exportTableNames } from "@/lib/data/tables";
export const metadata = { title: "数据管理" };
export default async function Page() {
  const user = await requireUser();
  return (
    <>
      <PageHeading
        eyebrow="YOUR DATA"
        title="数据管理"
        description="导出、备份，以及由你决定保留哪些记录。"
      />
      <DataSettings tables={exportTableNames} totpEnabled={Boolean(user.totpEnabledAt)} />
    </>
  );
}
