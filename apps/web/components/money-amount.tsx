import { formatAmount } from "@/lib/ledger/format";

// Only typography uses the character count. All monetary formatting stays decimal/string based.
export function MoneyAmount({
  value,
  currency,
  large = false,
}: {
  value: string;
  currency: string;
  large?: boolean;
}) {
  const formatted = formatAmount(value, currency);
  const digits = formatted.slice(currency.length + 1);
  return (
    <span className="@container block w-full min-w-0" title={formatted}>
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 text-[0.625rem] opacity-60">{currency}</span>{" "}
        <span
          data-money-value=""
          className="min-w-0 font-medium whitespace-nowrap tabular-nums"
          style={{
            fontSize: `clamp(0.375rem, calc((100cqi - 2rem) * 1.5 / ${digits.length}), ${large ? "2rem" : "1.5rem"})`,
            lineHeight: "1.25",
          }}
        >
          {digits}
        </span>
      </span>
    </span>
  );
}
export function InlineMoney({ value, currency }: { value: string; currency: string }) {
  const formatted = formatAmount(value, currency);
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap tabular-nums" title={formatted}>
      <span className="text-[0.75em] opacity-60">{currency}</span>{" "}
      <span data-money-value="" className="whitespace-nowrap tabular-nums">
        {formatted.slice(currency.length + 1)}
      </span>
    </span>
  );
}
