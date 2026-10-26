"use client";
import { useState } from "react";
import { Plus, ArrowLeftRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, api, useLedgerMutation, FormError } from "@/components/ledger/forms";
import { formatAmount } from "@/lib/ledger/format";
import type { RewardsOverview } from "@/lib/rewards/queries";
import { RewardEditor, type RewardForm } from "./forms";
import { RewardDetail } from "./detail";
export function RewardsView({
  data,
  cards,
}: {
  data: RewardsOverview;
  cards: { id: string; name: string }[];
}) {
  const [form, setForm] = useState<RewardForm | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState("accounts");
  const mutation = useLedgerMutation();
  const ownedPrograms = data.programs.filter((program) =>
    data.accounts.some((row) => row.programId === program.id),
  );
  const account = data.accounts.find((row) => row.id === selected);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <form className="flex items-end gap-2">
          <Field name="asOf" label="截至日期" type="date" defaultValue={data.asOf} required />
          <Button variant="outline">查看</Button>
        </form>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setForm({ kind: "account" })}>
            <Plus size={16} />
            添加积分账户
          </Button>
          <Button
            variant="outline"
            disabled={data.accounts.length < 2}
            onClick={() => setForm({ kind: "transfer" })}
          >
            <ArrowLeftRight size={16} />
            转点
          </Button>
        </div>
      </div>
      <section className="rounded-2xl border border-amber-900/15 bg-[#f4eee2] p-5 sm:p-7">
        <div className="flex items-center gap-2 text-xs tracking-wider text-amber-950/70">
          <Sparkles size={17} />
          REFERENCE VALUE · 非现金
        </div>
        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <div>
            <h2 className="text-xs text-muted-foreground">基准估值</h2>
            <p className="mt-2 text-3xl font-medium break-all tabular-nums">
              {data.accounts.length ? formatAmount(data.totalBaseline, "USD") : "等待第一笔积分"}
            </p>
          </div>
          <div>
            <h2 className="text-xs text-muted-foreground">个人使用估值</h2>
            <p className="mt-2 text-3xl font-medium break-all tabular-nums">
              {data.accounts.length ? formatAmount(data.totalPersonal, "USD") : "—"}
            </p>
          </div>
        </div>
        {data.unvaluedAccounts ? (
          <p className="mt-5 text-xs leading-6 text-amber-950/70">
            {data.unvaluedAccounts} 个账户缺少该日期的 CPP。
          </p>
        ) : null}
      </section>
      <div className="flex gap-1 overflow-x-auto border-b" role="tablist" aria-label="积分视图">
        {[
          ["accounts", "项目与账户"],
          ["cpp", "CPP 估值历史"],
        ].map(([key, label]) => (
          <button
            role="tab"
            aria-selected={tab === key}
            key={key}
            className={`shrink-0 border-b-2 px-4 py-3 text-sm ${tab === key ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground"}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <FormError error={mutation.error} />
      {tab === "accounts" ? (
        <>
          {!data.accounts.length ? (
            <div className="rounded-xl border border-dashed p-6 text-center">
              <h2 className="font-medium">还没有积分账户</h2>
              <p className="mt-2 mb-5 text-sm leading-7 text-muted-foreground">
                添加你持有的积分或里程账户，开始记录余额与变动。
              </p>
              <Button onClick={() => setForm({ kind: "account" })}>
                <Plus size={16} />
                添加积分账户
              </Button>
            </div>
          ) : null}
          <div className="grid gap-5 lg:grid-cols-2">
            {ownedPrograms.map((program) => {
              const members = data.accounts.filter((row) => row.programId === program.id);
              return (
                <section key={program.id} className="min-w-0 rounded-xl border bg-card p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="font-medium">
                        {program.code} {program.isArchived ? <Badge variant="outline">已归档</Badge> : null}
                      </h2>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{program.name}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={program.isArchived}
                      onClick={() => setForm({ kind: "account", programId: program.id })}
                    >
                      <Plus size={15} />
                      <span className="sr-only">添加 {program.code} 账户</span>
                    </Button>
                  </div>
                  {members.length ? (
                    <>
                      <div className="mt-4 border-b pb-4">
                        <p className="text-2xl break-all tabular-nums">
                          {BigInt(program.points).toLocaleString()}{" "}
                          <span className="text-xs text-muted-foreground">{program.unitLabel}</span>
                        </p>
                        <p className="mt-2 text-xs leading-6 text-muted-foreground">
                          基准 {formatAmount(program.baseline, "USD")} · 个人{" "}
                          {formatAmount(program.personal, "USD")}
                        </p>
                      </div>
                      <ul className="divide-y">
                        {members.map((row) => (
                          <li key={row.id}>
                            <button className="w-full py-4 text-left" onClick={() => setSelected(row.id)}>
                              <div className="flex items-start justify-between gap-3 text-sm">
                                <span>
                                  {row.name}
                                  {!row.isActive ? " · 已停用" : ""}
                                </span>
                                <span className="shrink-0 font-mono">
                                  {BigInt(row.points).toLocaleString()}
                                </span>
                              </div>
                              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                <span>
                                  30 天 {BigInt(row.change30) > 0n ? "+" : ""}
                                  {row.change30}
                                </span>
                                <span>累计获取 {row.earned}</span>
                                <span>累计兑换 {row.redeemed}</span>
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="mt-5 text-sm text-muted-foreground">尚无账户</p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-3 border-t pt-3">
                    <button
                      className="text-xs text-primary"
                      onClick={() => setForm({ kind: "cpp", programId: program.id })}
                    >
                      修改 CPP
                    </button>
                    <button
                      disabled={mutation.pending}
                      className="text-xs text-muted-foreground"
                      onClick={() =>
                        void mutation.run(async () => {
                          await api(`/api/loyalty/programs/${program.id}`, "PATCH", {
                            isArchived: !program.isArchived,
                          });
                        })
                      }
                    >
                      {program.isArchived ? "恢复项目" : "归档项目"}
                    </button>
                  </div>
                </section>
              );
            })}
          </div>
          <Button variant="outline" onClick={() => setForm({ kind: "program" })}>
            新增其他积分项目
          </Button>
        </>
      ) : null}
      {tab === "cpp" ? (
        <section className="rounded-xl border bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-medium">每点价值假设</h2>
            <Button size="sm" disabled={!ownedPrograms.length} onClick={() => setForm({ kind: "cpp" })}>
              新增 / 修正估值
            </Button>
          </div>
          <p className="mt-3 text-xs leading-6 text-muted-foreground">
            单位：美分 / 点。以生效日期为准，CPP 变化不会改变积分数量。
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[480px] text-left text-xs">
              <thead>
                <tr>
                  {["项目", "生效日期", "基准 CPP", "个人 CPP", "来源"].map((label) => (
                    <th className="py-3 font-medium" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.history
                  .filter((row) => ownedPrograms.some((program) => program.id === row.programId))
                  .toReversed()
                  .map((row) => (
                    <tr key={row.id} className="border-t">
                      <td className="py-3">
                        {data.programs.find((program) => program.id === row.programId)?.code}
                      </td>
                      <td>{row.effectiveDate}</td>
                      <td>{row.cppBaseline}</td>
                      <td>{row.cppPersonal}</td>
                      <td>{row.source === "default" ? "默认（可修改）" : "自定义"}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {account && !form ? (
        <RewardDetail account={account} onClose={() => setSelected(null)} onEdit={setForm} />
      ) : null}
      {form ? <RewardEditor form={form} data={data} cards={cards} onClose={() => setForm(null)} /> : null}
    </div>
  );
}
