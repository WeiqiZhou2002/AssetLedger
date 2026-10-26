"use client";
import { useState } from "react";
import Link from "next/link";
import type { benefitOverview } from "@/lib/benefits/queries";
import { InlineMoney, MoneyAmount } from "@/components/money-amount";
import { FormSheet } from "@/components/ledger/forms";
import { accountTileGrid, accountTileClass } from "@/components/ledger/account-tile";
type Data = Awaited<ReturnType<typeof benefitOverview>>;
export function BenefitDetails({ card, year }: { card: Data["cards"][number]; year: string }) {
  return (
    <div className="space-y-6">
      <div>
        <p className="mb-2 text-xs text-muted-foreground">{year} 年合计</p>
        <MoneyAmount value={card.annual} currency={card.currency} large />
      </div>
      {card.byName.length ? (
        <ul aria-label="按权益类型汇总" className="space-y-3 text-sm">
          {card.byName.map((credit) => (
            <li key={credit.name} className="min-w-0">
              <details className="rounded-lg border p-3">
                <summary className="cursor-pointer break-words">
                  <span className="font-medium">{credit.name}</span>
                  <span className="mt-1 block text-xs leading-6 text-muted-foreground">
                    {year} 年 <InlineMoney value={credit.total} currency={card.currency} /> · {credit.count}{" "}
                    次 · 最近 {credit.lastDate}
                  </span>
                </summary>
                <ul aria-label={`${credit.name} 流水`} className="mt-3 space-y-3 border-t pt-3 text-sm">
                  {credit.entries.map((entry) => (
                    <li key={entry.id}>
                      <Link className="break-words text-primary" href={`/activity?entryId=${entry.id}`}>
                        {entry.date} · {entry.description} ·{" "}
                        <InlineMoney value={entry.amount} currency={card.currency} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">所选年份尚无权益入账。</p>
      )}
      <Link
        className="block border-t pt-4 text-sm text-primary"
        href={`/activity?accountId=${card.accountId}`}
      >
        查看这张卡的全部流水 →
      </Link>
    </div>
  );
}
export function BenefitOverview({ data }: { data: Data }) {
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = data.cards.find((card) => card.accountId === detailId);
  return (
    <section className="space-y-5">
      <nav className="flex flex-wrap gap-3 text-sm" aria-label="权益统计年份">
        {data.years.map((year) => (
          <Link
            key={year}
            aria-current={data.year === year ? "page" : undefined}
            className={data.year === year ? "font-medium text-primary underline" : "text-muted-foreground"}
            href={`/benefits?year=${year}`}
          >
            {year} 年
          </Link>
        ))}
      </nav>
      <p className="text-xs leading-6 text-muted-foreground">
        已确认权益退款抵减支出，不计收入。金额保留各卡原币种；近 12 月统计截至 {data.asOf}。
      </p>
      {!data.cards.length ? (
        <p className="py-5 text-sm text-muted-foreground">添加信用卡账户后，可在这里查看权益返还。</p>
      ) : null}
      <div className={accountTileGrid}>
        {data.cards.map((card) => {
          const subline = [card.institution, card.last4 ? `•••• ${card.last4}` : null]
            .filter(Boolean)
            .join(" · ");
          return (
            <button
              type="button"
              key={card.accountId}
              aria-label={`查看 ${card.name} 权益`}
              onClick={() => setDetailId(card.accountId)}
              className={accountTileClass}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium" title={card.name}>
                  {card.name}
                </span>
              </span>
              {subline ? (
                <span className="mt-1 block truncate text-xs text-muted-foreground" title={subline}>
                  {subline}
                </span>
              ) : null}
              <span className="mt-3 block">
                <MoneyAmount value={card.annual} currency={card.currency} />
              </span>
              <span className="mt-1 block text-[0.625rem] text-muted-foreground">
                近 12 月 <InlineMoney value={card.rolling} currency={card.currency} />
              </span>
            </button>
          );
        })}
      </div>
      <FormSheet
        title={detail?.name ?? "卡权益"}
        description={`${data.year} 年权益返还明细`}
        open={Boolean(detail)}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
      >
        {detail ? <BenefitDetails card={detail} year={data.year} /> : null}
      </FormSheet>
    </section>
  );
}
