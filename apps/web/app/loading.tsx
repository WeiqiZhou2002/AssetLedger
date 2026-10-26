import { Skeleton } from "@/components/ui/skeleton";
export default function Loading() {
  return (
    <div role="status" aria-label="正在加载" className="space-y-6 p-6">
      <Skeleton className="h-10 w-44" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
