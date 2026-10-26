import { loadDashboard } from "@/lib/dashboard/load";
import { DashboardDetails } from "@/components/dashboard/details";
export const metadata = { title: "资产与收支明细" };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const view =
    typeof params.view === "string" &&
    ["assets", "liabilities", "net-worth", "spending", "income"].includes(params.view)
      ? params.view
      : "assets";
  return (
    <DashboardDetails
      {...await loadDashboard(params, view === "spending" || view === "income" ? view : undefined)}
      view={view}
    />
  );
}
