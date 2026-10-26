"use client";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatAmount } from "@/lib/ledger/format";
import { formatSpending } from "@/lib/dashboard/presentation";
import { decimal } from "@/lib/money/fx";
// Display coordinates only; no financial arithmetic or totals use these numbers.
const coordinate = (value: string | null) => (value === null ? null : Number(decimal(value).toFixed(2)));
const tick = (value: unknown) => decimal(String(value)).toFixed(0);
const palette = { cashLike: "#315c4c", investments: "#b27a3b", financial: "#718d9a" };
export function SpendingChart({
  rows,
  currency,
}: {
  rows: { date: string; amount: string | null }[];
  currency: string;
}) {
  const plotted = rows.map((row) => ({ ...row, plot: coordinate(row.amount) }));
  return (
    <div className="h-64 min-w-0" role="img" aria-label={`${currency} 每日真实消费柱形图`}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <BarChart data={plotted} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10 }}
            tickFormatter={(value: string) => value.slice(5)}
            minTickGap={22}
          />
          <YAxis width={65} tick={{ fontSize: 10 }} tickFormatter={tick} />
          <Tooltip
            content={({ active, payload, label }) => {
              const row = payload?.[0]?.payload as { date: string; amount: string | null } | undefined;
              return active && row ? (
                <div className="rounded-lg border bg-card p-3 text-xs shadow-md">
                  <p>{label}</p>
                  <p className="mt-2 font-mono">
                    {row.amount === null ? "汇率待补全" : formatSpending(row.amount, currency)}
                  </p>
                </div>
              ) : null;
            }}
          />
          <Bar dataKey="plot" fill={palette.cashLike} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
export function MarketHistoryChart({
  rows,
  currency,
}: {
  rows: { date: string; value: string }[];
  currency: string;
}) {
  return (
    <div className="h-52 min-w-0" role="img" aria-label={`${currency} 证券市值观察历史`}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart data={rows.map((row) => ({ ...row, plot: coordinate(row.value) }))}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
          <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(value: string) => value.slice(5)} />
          <YAxis width={65} tick={{ fontSize: 10 }} tickFormatter={tick} />
          <Tooltip
            content={({ active, payload, label }) => {
              const row = payload?.[0]?.payload as { value: string } | undefined;
              return active && row ? (
                <div className="rounded-lg border bg-card p-3 text-xs shadow-md">
                  {label}
                  <p className="mt-2">{formatAmount(row.value, currency)}</p>
                </div>
              ) : null;
            }}
          />
          <Line
            dataKey="plot"
            stroke={palette.investments}
            strokeWidth={2}
            dot={{ r: 3 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
