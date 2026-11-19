import Link from "next/link";
import { InlineMoney } from "@/components/money-amount";
import { Badge } from "@/components/ui/badge";
import { money } from "@/lib/money";
import type { BenefitEntry, Conditions, ProgressInstance } from "@/lib/benefits/progress/types";
import type { CatalogDetails } from "./types";
const states = {
  full: "已报销",
  partial: "部分报销",
  unused: "未报销",
  over: "超出额度",
  upcoming: "未开始",
};
export function periodLabel(period: string, years: number | null) {
  const labels: Record<string, string> = {
    monthly: "每月",
    quarterly: "每季度",
    semiannual: "每半年",
    annual: "每年",
    multi_year: `每 ${years ?? "—"} 年`,
  };
  return Object.hasOwn(labels, period) ? labels[period] : "周期待确认";
}
function basisLabel(basis: string) {
  const labels: Record<string, string> = {
    calendar: "自然年",
    anniversary: "卡年度",
    anniversary_statement: "账单年度",
    since_last_credit: "自上次报销起",
  };
  return Object.hasOwn(labels, basis) ? labels[basis] : "特殊周期";
}
function EntryLinks({ entries }: { entries: BenefitEntry[] }) {
  return (
    <ul className="mt-2 space-y-2 text-xs leading-6">
      {entries.map((entry) => (
        <li key={entry.id}>
          <Link href={`/activity?entryId=${entry.id}`} className="break-words text-primary">
            {entry.date} · {entry.description || entry.merchant || "权益报销"} ·{" "}
            <InlineMoney value={entry.amount} currency={entry.currency} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
function ConditionsLabel({ conditions, currency }: { conditions: Conditions; currency: string }) {
  const spend = conditions.minimum_spend;
  const spendLabel = spend
    ? ({
        transaction: "单笔消费满",
        benefit_period: "本期消费满",
        previous_calendar_year: "上一自然年消费满",
      }[spend.period] ?? "消费满")
    : null;
  return (
    <p className="mt-2 text-xs leading-6 text-muted-foreground">
      需满足条件：
      {spend ? (
        <>
          {spendLabel} <InlineMoney value={spend.amount} currency={currency} />；
        </>
      ) : null}
      {conditions.minimum_nights ? <>至少 {conditions.minimum_nights} 晚；</> : null}
      {conditions.consecutive_months ? <>连续 {conditions.consecutive_months} 个月</> : null}
    </p>
  );
}
function ReimbursementRow({
  instance,
  currency,
  accountId,
}: {
  instance: ProgressInstance;
  currency: string;
  accountId: string;
}) {
  const current = instance.status === "ok" && "year" in instance ? instance.current_period : null;
  const termsNote = instance.terms_as_of ? (
    <p className="mt-2 text-xs text-muted-foreground">
      条款核实于 {instance.terms_as_of}，起始生效日未公布。
    </p>
  ) : null;
  const message =
    instance.status === "needs_anniversary"
      ? "请在账户设置中填写开户日期，以计算卡年度进度。"
      : instance.status === "needs_statement_day"
        ? "请在账户设置中填写账单日，以计算账单年度进度。"
        : instance.status === "to_verify"
          ? "条款待核实，暂不计算。"
          : instance.status === "unsupported"
            ? "该权益的周期规则暂不支持，仅列出额度。"
            : null;
  return (
    <li className="min-w-0 rounded-lg border p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="font-medium break-words">{instance.name}</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            {periodLabel(instance.period, instance.period_years)} · {basisLabel(instance.reset_basis)}
          </p>
        </div>
        {current ? (
          <Badge variant={current.state === "over" ? "destructive" : "secondary"}>
            {states[current.state]}
          </Badge>
        ) : null}
      </div>
      {instance.enrollment === "required" || instance.enrollment === "activation" ? (
        <Badge variant="outline" className="mt-2">
          {instance.enrollment === "required" ? "需登记" : "需激活"}
        </Badge>
      ) : null}
      {instance.conditions ? <ConditionsLabel conditions={instance.conditions} currency={currency} /> : null}
      {message ? (
        <div className="mt-3 space-y-2 leading-6">
          <p>{message}</p>
          {instance.amount !== null ? (
            <p>
              额度 <InlineMoney value={instance.amount} currency={currency} />
            </p>
          ) : null}
          {instance.status === "needs_anniversary" || instance.status === "needs_statement_day" ? (
            <Link href={`/accounts#account-${accountId}`} className="text-primary">
              前往账户，编辑{instance.status === "needs_anniversary" ? "开户日期" : "账单日"} →
            </Link>
          ) : null}
          <EntryLinks entries={instance.entry_details} />
        </div>
      ) : null}
      {instance.status === "ok" && "eligible" in instance ? (
        <div className="mt-3 leading-6">
          <p>
            {instance.eligible
              ? "可使用"
              : `已使用（${instance.window!.start}），${instance.window!.next_eligible_on} 起可再次使用`}
          </p>
          {instance.amount !== null ? (
            <p>
              额度 <InlineMoney value={instance.amount} currency={currency} />
            </p>
          ) : null}
          {instance.window ? (
            <p>
              本期已报销 <InlineMoney value={instance.window.used} currency={currency} /> /{" "}
              <InlineMoney value={instance.window.cap} currency={currency} />
            </p>
          ) : null}
          <EntryLinks
            entries={instance.entry_details.filter((entry) => instance.entries.includes(entry.id))}
          />
        </div>
      ) : null}
      {instance.status === "ok" && "year" in instance ? (
        <>
          {current ? (
            <p className="mt-3 leading-6">
              本期已报销 <InlineMoney value={current.used} currency={currency} /> /{" "}
              <InlineMoney value={current.cap} currency={currency} />
              ，剩余 <InlineMoney value={current.remaining} currency={currency} />，{current.end} 截止
            </p>
          ) : (
            <p className="mt-3 text-muted-foreground">
              {instance.periods.every((period) => period.state === "upcoming")
                ? "未开始"
                : "当前日期不在本年度权益周期内。"}
            </p>
          )}
          {instance.latest_entry ? (
            <p className="mt-1 text-xs leading-6 text-muted-foreground">
              最近报销：{instance.latest_entry.date}{" "}
              <InlineMoney value={instance.latest_entry.amount} currency={currency} />
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">尚无报销</p>
          )}
          {money(instance.year.excess).gt(0) ? (
            <p className="mt-2 text-destructive">
              超出额度 <InlineMoney value={instance.year.excess} currency={currency} />
              ，请检查是否对应错误。
            </p>
          ) : null}
          <details className="mt-3 border-t pt-3">
            <summary className="cursor-pointer text-xs leading-6">
              年度已报销 <InlineMoney value={instance.year.used} currency={currency} /> /{" "}
              <InlineMoney value={instance.year.cap} currency={currency} /> · 已过期未用{" "}
              <InlineMoney value={instance.year.expired_unused} currency={currency} /> · 待开始{" "}
              <InlineMoney value={instance.year.upcoming} currency={currency} />
              <span className="block text-muted-foreground">
                {instance.year.start} 至 {instance.year.end}
              </span>
            </summary>
            {termsNote}
            <ol className="mt-3 space-y-3" aria-label={`${instance.name} 周期`}>
              {instance.periods.map((period) => (
                <li key={period.start} className="border-t pt-3 text-xs leading-6">
                  <p>
                    {period.start} 至 {period.end} · {states[period.state]} ·{" "}
                    <InlineMoney value={period.used} currency={currency} /> /{" "}
                    <InlineMoney value={period.cap} currency={currency} />
                  </p>
                  <EntryLinks
                    entries={period.entries.flatMap((id) =>
                      instance.entry_details.filter((entry) => entry.id === id),
                    )}
                  />
                </li>
              ))}
            </ol>
            {instance.unplaced.length ? (
              <div className="mt-3">
                <p className="text-xs text-muted-foreground">未计入周期的报销</p>
                <EntryLinks
                  entries={instance.entry_details.filter((entry) => instance.unplaced.includes(entry.id))}
                />
              </div>
            ) : null}
          </details>
        </>
      ) : null}
      {instance.status === "ok" && "year" in instance ? null : termsNote}
    </li>
  );
}
export function BenefitProgressSection({
  catalog,
  accountId,
}: {
  catalog: CatalogDetails;
  accountId: string;
}) {
  return (
    <>
      <section className="space-y-3" aria-label="权益报销">
        <h3 className="font-medium">权益报销</h3>
        {catalog.instances.length ? (
          <ul className="space-y-3">
            {catalog.instances.map((instance) => (
              <ReimbursementRow
                key={instance.credit}
                instance={instance}
                currency={catalog.currency}
                accountId={accountId}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">所选年份暂无可展示的目录权益。</p>
        )}
      </section>
      {catalog.informational.length ? (
        <section className="space-y-3" aria-label="不在账单上入账">
          <h3 className="font-medium">不在账单上入账</h3>
          <ul className="space-y-2 text-sm leading-6 text-muted-foreground">
            {catalog.informational.map((credit) => (
              <li key={credit.credit}>
                {credit.name} ·{" "}
                {credit.amount !== null ? (
                  <InlineMoney value={credit.amount} currency={catalog.currency} />
                ) : (
                  "额度待核实"
                )}{" "}
                / {periodLabel(credit.period, credit.period_years)}，不会出现在信用卡流水中。
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
export function BenefitCatalogFooter({ catalog }: { catalog: CatalogDetails }) {
  return (
    <footer className="space-y-2 border-t pt-4 text-xs leading-6 text-muted-foreground">
      <p>额度与周期来自 CardFacts {catalog.catalogVersion}（草案数据），以发卡机构条款为准。</p>
      <ul>
        {catalog.sources.map((source) => (
          <li key={source.id}>
            <a href={source.url} target="_blank" rel="noreferrer" className="break-words text-primary">
              {source.title}
            </a>
          </li>
        ))}
      </ul>
    </footer>
  );
}
