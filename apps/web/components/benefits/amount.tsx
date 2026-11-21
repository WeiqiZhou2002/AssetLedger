import { formatAmount } from "@/lib/ledger/format";

export function formatBenefitAmount(value: string, currency: string): string {
  const digits = formatAmount(value, currency)
    .slice(currency.length + 1)
    .replace(/\.00$/, "");
  return currency === "USD" ? `$${digits}` : `${currency} ${digits}`;
}

export function BenefitAmount({
  value,
  currency,
  large = false,
}: {
  value: string;
  currency: string;
  large?: boolean;
}) {
  const formatted = formatBenefitAmount(value, currency);
  return (
    <span
      title={formatAmount(value, currency)}
      className={
        large ? "@container block w-full min-w-0 font-medium tabular-nums" : "whitespace-nowrap tabular-nums"
      }
    >
      <span
        data-money-value=""
        className="whitespace-nowrap"
        style={
          large
            ? {
                fontSize: `clamp(0.375rem, calc(100cqi * 1.5 / ${formatted.length}), 2rem)`,
                lineHeight: "1.25",
              }
            : undefined
        }
      >
        {formatted}
      </span>
    </span>
  );
}
