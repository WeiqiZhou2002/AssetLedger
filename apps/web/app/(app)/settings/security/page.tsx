import { requireUser } from "@/lib/auth/current-user";
import { PageHeading } from "@/components/page-heading";
import { SecurityForm } from "@/components/security-form";
export const metadata = { title: "安全" };
export default async function Security() {
  const user = await requireUser();
  return (
    <>
      <PageHeading eyebrow="SECURITY" title="让账簿更安心" description="你的财务资料，值得多一层保护。" />
      <SecurityForm enabled={Boolean(user.totpEnabledAt)} />
    </>
  );
}
