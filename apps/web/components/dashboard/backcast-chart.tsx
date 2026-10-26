"use client";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { BackcastDay } from "@/lib/dashboard/backcast-core";
import { decimal } from "@/lib/money/fx";
import { InlineMoney } from "@/components/money-amount";

// Number conversion belongs only to the rendering boundary; tooltips retain the original strings.
const coordinate = (value: string | null) => (value === null ? null : Number(decimal(value).toFixed(2)));
export function backcastPlot(days: BackcastDay[]) {
  return days.map((day, index) => {
    const partial =
      !day.complete || days[index - 1]?.complete === false || days[index + 1]?.complete === false;
    return {
      ...day,
      netSolid: day.complete ? coordinate(day.netWorth) : null,
      netPartial: partial ? coordinate(day.netWorth) : null,
      assetsSolid: day.complete ? coordinate(day.assets) : null,
      assetsPartial: partial ? coordinate(day.assets) : null,
      liabilitiesSolid: day.complete ? coordinate(day.liabilities) : null,
      liabilitiesPartial: partial ? coordinate(day.liabilities) : null,
    };
  });
}
export function BackcastChart({
  days,
  currency,
  showAssets,
  showLiabilities,
}: {
  days: BackcastDay[];
  currency: string;
  showAssets: boolean;
  showLiabilities: boolean;
}) {
  const plotted = backcastPlot(days);
  const lines = [
    { key: "net", name: "净资产", color: "#315c4c", visible: true },
    { key: "assets", name: "资产", color: "#718d9a", visible: showAssets },
    { key: "liabilities", name: "负债", color: "#b27a3b", visible: showLiabilities },
  ];
  return (
    <div
      className="h-72 min-w-0 sm:h-80"
      role="img"
      aria-label={`${currency} 净资产回溯走势；虚线为估计或未完全覆盖`}
    >
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart data={plotted} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10 }}
            tickFormatter={(value: string) => value.slice(5)}
            minTickGap={28}
          />
          <YAxis
            width={65}
            tick={{ fontSize: 10 }}
            tickFormatter={(value: unknown) => decimal(String(value)).toFixed(0)}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              const day = payload?.[0]?.payload as BackcastDay | undefined;
              return active && day ? (
                <div className="max-w-[16rem] rounded-lg border bg-card p-3 text-xs shadow-md">
                  <p className="mb-2 font-medium">
                    {label}
                    {day.estimated ? " · 估计" : day.complete ? "" : " · 未完全覆盖"}
                  </p>
                  {(
                    [
                      ["assets", "资产"],
                      ["liabilities", "负债"],
                      ["netWorth", "净资产"],
                    ] as const
                  ).map(([key, title]) => (
                    <p key={key} className="mt-2">
                      {title}：
                      {day[key] === null ? "未覆盖" : <InlineMoney value={day[key]} currency={currency} />}
                    </p>
                  ))}
                  {day.uncovered.length ? (
                    <p className="mt-2 leading-5">
                      {day.uncovered.map((row) => `${row.name}：${row.reason}`).join("；")}
                    </p>
                  ) : null}
                  {day.fxFallbackAccounts.length ? (
                    <p className="mt-2">
                      使用估计汇率：{day.fxFallbackAccounts.map((row) => row.name).join("、")}
                    </p>
                  ) : null}
                </div>
              ) : null;
            }}
          />
          {lines
            .filter((line) => line.visible)
            .flatMap((line) => [
              <Line
                key={`${line.key}-partial`}
                dataKey={`${line.key}Partial`}
                name={`${line.name}（部分）`}
                stroke={line.color}
                strokeDasharray="5 4"
                strokeOpacity={0.5}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />,
              <Line
                key={line.key}
                dataKey={`${line.key}Solid`}
                name={line.name}
                stroke={line.color}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />,
            ])}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
