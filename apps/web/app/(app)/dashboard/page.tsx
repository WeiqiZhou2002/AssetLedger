import { loadDashboard } from "@/lib/dashboard/load";
import { PersonalOverview } from "@/components/dashboard/personal-overview";
export const metadata = { title: "总览" };
export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <PersonalOverview {...await loadDashboard({ ...(await searchParams), month: undefined })} />;
}
