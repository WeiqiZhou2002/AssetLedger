import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { money } from "@/lib/money";
import type { BenefitEntry, Conditions } from "@/lib/benefits/progress/types";
import type { DisplayInstance } from "@/lib/benefits/marks";
import { addDays, addYears } from "@/lib/benefits/progress/dates";
import { creditStatus, groupCredits } from "@/lib/benefits/display";
import { BenefitAmount } from "./amount";
import { BenefitAssignmentSelect } from "./assignment-select";
import { BenefitMarkCheckbox } from "./mark-checkbox";
import type { CatalogDetails } from "./types";
const states = {
  used: "本期已用",
  partial: "本期部分使用",
  unused: "本期未用",
  upcoming: "未开始",
  eligible: "可使用",
  cooldown: "已使用",
  conditional: "需满足条件",
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
function FaceValue({
  credit,
  currency,
}: {
  credit: { amount: string | null; period: string; period_years: number | null };
  currency: string;
}) {
  return credit.amount === null ? (
    "待核实"
  ) : (
    <>
      {periodLabel(credit.period, credit.period_years)}{" "}
      <BenefitAmount value={credit.amount} currency={currency} />
    </>
  );
}
function EntryLinks({
  entries,
  catalog,
  name,
}: {
  entries: BenefitEntry[];
  catalog: CatalogDetails;
  name: string;
}) {
  if (!entries.length) return null;
  return (
    <ul aria-label={`${name} 流水`} className="space-y-2 border-t pt-2 text-xs leading-6">
      {entries.map((entry) => (
        <li key={entry.id} className="min-w-0">
          <Link href={`/activity?entryId=${entry.id}`} className="text-primary">
            {entry.date} · <BenefitAmount value={entry.amount} currency={entry.currency} />
          </Link>
          <BenefitAssignmentSelect
            entryId={entry.id}
            productId={catalog.productId}
            credits={catalog.credits}
            assignment={catalog.entryAssignments[entry.id]}
          />
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
        previous_calendar_year: "上一年消费满",
      }[spend.period] ?? "消费满")
    : null;
  const labels = [
    conditions.minimum_nights ? `至少 ${conditions.minimum_nights} 晚` : null,
    conditions.consecutive_months ? `连续 ${conditions.consecutive_months} 个月` : null,
  ].filter(Boolean);
  return (
    <p className="text-muted-foreground">
      需满足条件：
      {spend ? (
        <>
          {spendLabel} <BenefitAmount value={spend.amount} currency={currency} />
          {labels.length ? "；" : ""}
        </>
      ) : null}
      {labels.join("；")}
    </p>
  );
}
function ReimbursementRow({
  instance,
  accountId,
  asOf,
  catalog,
  year,
}: {
  instance: DisplayInstance;
  year: string;
  catalog: CatalogDetails;
  accountId: string;
  asOf: string;
}) {
  const current = instance.status === "ok" && "year" in instance ? instance.current_period : null;
  const status = creditStatus(instance, asOf, year);
  const markProps = { accountId, productId: catalog.productId, creditId: instance.credit };
  const entries = instance.entry_details
    .filter((entry) => entry.date.startsWith(`${year}-`) && entry.date <= asOf)
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  return (
    <li className="min-w-0">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 py-3 text-sm [&::-webkit-details-marker]:hidden">
          <span
            className="min-w-0 flex-1 truncate font-medium group-open:whitespace-normal"
            title={instance.name}
          >
            {instance.name}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            <FaceValue credit={instance} currency={catalog.currency} />
          </span>
          <span className="shrink-0 text-right">
            <BenefitAmount value={catalog.reimbursed[instance.credit] ?? "0"} currency={catalog.currency} />
          </span>
          {status ? (
            <Badge variant="secondary" className="shrink-0 text-[0.625rem]">
              {states[status]}
            </Badge>
          ) : null}
          <ChevronDown
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="min-w-0 space-y-2 pb-3 text-xs leading-6">
          {current && current.start <= asOf && asOf <= current.end ? (
            <>
              <p className="text-muted-foreground">
                本期 {current.start} 至 {current.end}
              </p>
              {current.marked || current.state === "unused" || current.state === "partial" ? (
                <BenefitMarkCheckbox
                  {...markProps}
                  label="本期已报销"
                  marked={current.marked}
                  periodStart={current.activeMark?.periodStart ?? current.start}
                  periodEnd={current.activeMark?.periodEnd ?? current.end}
                />
              ) : null}
            </>
          ) : null}
          {instance.status === "estimated" && year >= asOf.slice(0, 4) ? (
            <>
              <p className="text-muted-foreground">卡年度未知，按近 12 个月估算</p>
              {instance.marked || money(instance.window.used).lt(instance.window.cap) ? (
                <BenefitMarkCheckbox
                  {...markProps}
                  label="已报销"
                  marked={instance.marked}
                  periodStart={instance.activeMark?.periodStart ?? asOf}
                  periodEnd={instance.activeMark?.periodEnd ?? addDays(addYears(asOf, 1), -1)}
                />
              ) : null}
            </>
          ) : null}
          {instance.status === "ok" && "eligible" in instance ? (
            <>
              {instance.marked || instance.eligible ? (
                <BenefitMarkCheckbox
                  {...markProps}
                  label="已报销"
                  marked={instance.marked}
                  periodStart={instance.activeMark?.periodStart ?? asOf}
                  periodEnd={
                    instance.activeMark?.periodEnd ?? addDays(addYears(asOf, instance.period_years!), -1)
                  }
                />
              ) : null}
              {!instance.eligible && instance.window ? (
                <p className="text-muted-foreground">{instance.window.next_eligible_on} 起可再次使用</p>
              ) : null}
            </>
          ) : null}
          {instance.status === "to_verify" ? <p className="text-muted-foreground">条款待核实</p> : null}
          {instance.status === "unsupported" ? (
            <p className="text-muted-foreground">周期规则暂不支持</p>
          ) : null}
          {instance.conditions ? (
            <ConditionsLabel conditions={instance.conditions} currency={catalog.currency} />
          ) : null}
          {instance.enrollment === "required" || instance.enrollment === "activation" ? (
            <Badge variant="outline">{instance.enrollment === "required" ? "需登记" : "需激活"}</Badge>
          ) : null}
          {instance.status === "ok" && "year" in instance && money(instance.year.excess).gt("0") ? (
            <p className="text-destructive">
              超出额度 <BenefitAmount value={instance.year.excess} currency={catalog.currency} />
              ，可能对应错误
            </p>
          ) : null}
          <EntryLinks entries={entries} catalog={catalog} name={instance.name} />
        </div>
      </details>
    </li>
  );
}
export function BenefitProgressSection({
  catalog,
  accountId,
  asOf,
  year = asOf.slice(0, 4),
}: {
  year?: string;
  catalog: CatalogDetails;
  accountId: string;
  asOf: string;
}) {
  const { main, other } = groupCredits(catalog.instances, catalog.reimbursed);
  const otherCount = other.length + catalog.informational.length;
  const rows = (instances: DisplayInstance[], label: string) => (
    <ul aria-label={label} className="divide-y border-y">
      {instances.map((instance) => (
        <ReimbursementRow
          key={instance.credit}
          instance={instance}
          catalog={catalog}
          year={year}
          accountId={accountId}
          asOf={asOf}
        />
      ))}
    </ul>
  );
  return (
    <>
      {main.length ? rows(main, "权益报销") : null}
      {otherCount ? (
        <details className="group/folded border-y">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 py-3 text-sm [&::-webkit-details-marker]:hidden">
            <span>其他报销项目 · {otherCount} 项</span>
            <ChevronDown
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground transition-transform group-open/folded:rotate-180"
            />
          </summary>
          {other.length ? rows(other, "其他报销项目") : null}
          {catalog.informational.length ? (
            <ul aria-label="不在账单上入账" className="divide-y text-xs leading-6 text-muted-foreground">
              {catalog.informational.map((credit) => (
                <li key={credit.credit} className="py-2">
                  {credit.name} · <FaceValue credit={credit} currency={catalog.currency} /> · 不在账单上入账
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      ) : null}
    </>
  );
}
export function BenefitCatalogFooter({ catalog }: { catalog: CatalogDetails }) {
  return (
    <footer className="space-y-2 border-t pt-4 text-xs leading-6 text-muted-foreground">
      <p>数据来自 CardFacts {catalog.catalogVersion}（草案），以发卡机构条款为准</p>
      <details>
        <summary className="cursor-pointer">来源 · {catalog.sources.length}</summary>
        <ul aria-label="权益来源" className="mt-2">
          {catalog.sources.map((source) => (
            <li key={source.id}>
              <a href={source.url} target="_blank" rel="noreferrer" className="break-words text-primary">
                {source.title}
              </a>
            </li>
          ))}
        </ul>
      </details>
    </footer>
  );
}
