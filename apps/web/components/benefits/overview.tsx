"use client";
import { useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import type { BenefitCard, BenefitData as Data } from "./types";
import { BenefitAssignmentSelect } from "./assignment-select";
import { BenefitProfileForm } from "./profile-form";
import { BenefitCatalogFooter, BenefitProgressSection } from "./progress";
import { Badge } from "@/components/ui/badge";
import { BenefitAmount } from "./amount";
import { FormSheet } from "@/components/ledger/forms";
import { accountTileGrid, accountTileClass } from "@/components/ledger/account-tile";
export function BenefitDetails({
  card,
  year,
  products = [],
}: {
  card: BenefitCard;
  year: string;
  products?: Data["products"];
}) {
  const catalog = card.catalog && !card.catalog.stale ? card.catalog : null;
  const profileForm = (
    <BenefitProfileForm
      key={`${card.accountId}:${card.catalog?.productId}:${card.productSource}`}
      card={card}
      products={products}
    />
  );
  return (
    <div className="space-y-6">
      {catalog ? (
        <details>
          <summary className="cursor-pointer text-sm break-words">
            卡产品：{catalog.productName}{" "}
            {card.productSource === "auto" ? <Badge variant="secondary">自动匹配</Badge> : null}
            <span className="ml-2 text-xs text-muted-foreground">更改</span>
          </summary>
          <div className="mt-3">{profileForm}</div>
        </details>
      ) : (
        profileForm
      )}
      <div>
        <p className="mb-2 text-xs text-muted-foreground">{year} 年已报销</p>
        <BenefitAmount value={card.annual} currency={card.currency} large />
      </div>
      {catalog ? (
        <BenefitProgressSection catalog={catalog} accountId={card.accountId} asOf={card.asOf} year={year} />
      ) : null}
      {card.byName.length ? (
        catalog ? (
          <details className="group/folded border-y">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 py-3 text-sm [&::-webkit-details-marker]:hidden">
              <span>
                目录外的权益返还 · {card.byName.reduce((count, group) => count + group.count, 0)} 笔
              </span>
              <ChevronDown
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground transition-transform group-open/folded:rotate-180"
              />
            </summary>
            <OtherBenefitGroups card={card} />
          </details>
        ) : (
          <OtherBenefitGroups card={card} />
        )
      ) : !catalog ? (
        <p className="text-sm text-muted-foreground">所选年份尚无权益入账。</p>
      ) : null}
      <Link
        className="block border-t pt-4 text-sm text-primary"
        href={`/activity?accountId=${card.accountId}`}
      >
        查看这张卡的全部流水 →
      </Link>
      {catalog ? <BenefitCatalogFooter catalog={catalog} /> : null}
    </div>
  );
}
function OtherBenefitGroups({ card }: { card: BenefitCard }) {
  const catalog = card.catalog && !card.catalog.stale ? card.catalog : null;
  return (
    <ul aria-label="按权益类型汇总" className="divide-y border-y text-sm">
      {card.byName.map((credit) => (
        <li key={credit.name} className="min-w-0">
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 py-3 [&::-webkit-details-marker]:hidden">
              <span
                className="min-w-0 flex-1 truncate font-medium group-open:whitespace-normal"
                title={credit.name}
              >
                {credit.name}
              </span>
              <BenefitAmount value={credit.total} currency={card.currency} />
              <ChevronDown
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
              />
            </summary>
            <ul aria-label={`${credit.name} 流水`} className="space-y-2 pb-3 text-xs leading-6">
              {credit.entries.map((entry) => (
                <li key={entry.id} className="min-w-0">
                  <Link className="text-primary" href={`/activity?entryId=${entry.id}`}>
                    {entry.date} · <BenefitAmount value={entry.amount} currency={card.currency} />
                  </Link>
                  {catalog ? (
                    <BenefitAssignmentSelect
                      entryId={entry.id}
                      productId={catalog.productId}
                      credits={catalog.credits}
                      assignment={catalog.entryAssignments[entry.id]}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        </li>
      ))}
    </ul>
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
              <span className="mt-3 mb-1 block text-xs text-muted-foreground">{data.year} 年已报销</span>
              <BenefitAmount value={card.annual} currency={card.currency} large />
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
        {detail ? <BenefitDetails card={detail} year={data.year} products={data.products} /> : null}
      </FormSheet>
    </section>
  );
}
