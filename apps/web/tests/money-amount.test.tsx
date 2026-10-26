import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MoneyAmount, InlineMoney } from "@/components/money-amount";
it.each(["1234567.89", "-7654321.01", "0", "9999999999999999.9999"])(
  "keeps %s on one line and scales by container width without converting money to numbers",
  (value) => {
    const html = renderToStaticMarkup(<MoneyAmount value={value} currency="USD" large />);
    expect(html).toMatch(/data-money-value="" class="[^"]*whitespace-nowrap[^"]*tabular-nums/);
    expect(html).toContain("@container");
    expect(html).toContain("100cqi");
    expect(html).toContain("clamp(");
    expect(html).not.toContain("break-all");
    expect(html).not.toContain("font-mono");
    expect(html).toContain('opacity-60">USD</span>');
    expect(renderToStaticMarkup(<InlineMoney value={value} currency="USD" />)).toMatch(
      /data-money-value="" class="[^"]*whitespace-nowrap/,
    );
  },
);
