"use client";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { RewardsOverview } from "@/lib/rewards/queries";
import { formatAmount } from "@/lib/ledger/format";
import { decimal } from "@/lib/money/fx";
export default function RewardsChart({ rows }: { rows: RewardsOverview["accounts"][number]["chart"] }) {
  // Numbers are drawing coordinates only. Exact integer/Decimal strings remain the source for labels.
  const points = rows.map((row) => ({
    ...row,
    pointCoordinate: decimal(row.points).toNumber(),
    baselineCoordinate: row.baseline === null ? null : decimal(row.baseline).toNumber(),
    personalCoordinate: row.personal === null ? null : decimal(row.personal).toNumber(),
  }));
  return (
    <div
      className="mt-5 h-72 min-w-0"
      role="img"
      aria-label="近三十天点数与美元参考估值曲线；详细点数见事件和观察记录"
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 10, right: 5, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(date: string) => date.slice(5)} />
          <YAxis yAxisId="points" width={54} tick={{ fontSize: 10 }} />
          <YAxis yAxisId="usd" orientation="right" width={54} tick={{ fontSize: 10 }} />
          <Tooltip
            content={({ active, payload, label }) => {
              const row = rows.find((item) => item.date === label);
              return active && payload?.length && row ? (
                <div className="rounded-lg border bg-card p-3 text-xs shadow-sm">
                  <p>{row.date}</p>
                  <p className="mt-2">{row.points} 点 / 里程</p>
                  <p>基准 {row.baseline === null ? "无估值" : formatAmount(row.baseline, "USD")}</p>
                  <p>个人 {row.personal === null ? "无估值" : formatAmount(row.personal, "USD")}</p>
                </div>
              ) : null;
            }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line
            yAxisId="points"
            dataKey="pointCoordinate"
            name="点数（左轴）"
            stroke="var(--primary)"
            type="stepAfter"
            dot={false}
          />
          <Line
            yAxisId="usd"
            dataKey="baselineCoordinate"
            name="基准 USD（右轴）"
            stroke="#a28b5b"
            strokeDasharray="4 3"
            type="stepAfter"
            dot={false}
          />
          <Line
            yAxisId="usd"
            dataKey="personalCoordinate"
            name="个人 USD（右轴）"
            stroke="#657d91"
            type="stepAfter"
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
