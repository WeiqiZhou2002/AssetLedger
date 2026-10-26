"use client";
import dynamic from "next/dynamic";
const SpendingChart = dynamic(() => import("./charts").then((module) => module.SpendingChart), {
  ssr: false,
  loading: () => <p className="h-64 p-4 text-sm text-muted-foreground">加载支出图表…</p>,
});
export function CurrentSpendingChart(props: { rows: { date: string; amount: string }[]; currency: string }) {
  return <SpendingChart {...props} />;
}
