import { beforeEach, expect, it, vi } from "vitest";
import { Children, isValidElement, useState, type ReactNode, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BenefitOverview } from "@/components/benefits/overview";
import { ConnectionDisclosure, connectionNeedsAttention } from "@/components/bank-sync/connection-disclosure";
import { accountTileClass, accountTileGrid } from "@/components/ledger/account-tile";
import { AppNavigation } from "@/components/app-navigation";
import { FormSheet } from "@/components/ledger/forms";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/benefits",
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: vi.fn(actual.useState) };
});
vi.mock("@/components/ledger/forms", async (original) => {
  const actual = await original<typeof import("@/components/ledger/forms")>();
  return {
    ...actual,
    FormSheet: ({ open, children, title }: ComponentProps<typeof actual.FormSheet>) =>
      open ? (
        <section role="dialog" aria-label={title}>
          {children}
        </section>
      ) : null,
  };
});
const realReact = await vi.importActual<typeof import("react")>("react");
let state: unknown[];
beforeEach(() => {
  state = [];
});
function view<T>(render: () => T) {
  let cursor = 0;
  vi.mocked(useState).mockImplementation(<S,>(initial?: S | (() => S)) => {
    const index = cursor++;
    if (!(index in state)) state[index] = typeof initial === "function" ? (initial as () => S)() : initial;
    return [
      state[index] as S,
      (next: S | ((previous: S) => S)) => {
        state[index] = typeof next === "function" ? (next as (previous: S) => S)(state[index] as S) : next;
      },
    ];
  });
  try {
    return render();
  } finally {
    vi.mocked(useState).mockImplementation(realReact.useState);
  }
}
type Props = {
  children?: ReactNode;
  onClick?: () => void;
  className?: string;
  hidden?: boolean;
  "aria-expanded"?: boolean;
  "aria-label"?: string;
  onOpenChange?: (open: boolean) => void;
};
function elements(node: ReactNode): React.ReactElement<Props>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Props>(child) ? [child, ...elements(child.props.children)] : [],
  );
}
const data: ComponentProps<typeof BenefitOverview>["data"] = {
  asOf: "2026-10-24",
  year: "2026",
  since: "2025-10-24",
  years: ["2026", "2025"],
  cards: [
    {
      accountId: "synthetic-card",
      name: "Demo Card",
      institution: "Example Bank",
      last4: "1234",
      currency: "USD",
      annual: "30.0000",
      rolling: "40.0000",
      byName: [
        {
          name: "Dining Credit",
          count: 2,
          total: "30.0000",
          lastDate: "2026-10-22",
          entries: [
            { id: "synthetic-entry", date: "2026-10-22", description: "DINING CREDIT", amount: "30.0000" },
          ],
        },
      ],
      families: [
        {
          family: "dining",
          annual: "30.0000",
          rolling: "40.0000",
          entries: [
            { id: "synthetic-entry", date: "2026-10-22", description: "DINING CREDIT", amount: "30.0000" },
            { id: "old-entry", date: "2025-11-01", description: "DINING CREDIT", amount: "10.0000" },
          ],
        },
      ],
    },
  ],
};
const connection: ComponentProps<typeof ConnectionDisclosure>["connection"] = {
  id: "synthetic",
  institutionName: "Example Bank",
  status: "active",
  errorCode: null,
  mappingConfirmedAt: "2026-10-20T12:00:00Z",
  lastSuccessAt: "2026-10-24T12:00:00Z",
  accounts: [
    { accountId: "synthetic-account", securityAccountId: null, isEnabled: true, type: "depository" },
  ],
};
it("benefit tiles reuse account classes and open a sheet with annual names, last dates and entry links", () => {
  let tree = view(() => BenefitOverview({ data }));
  const all = elements(tree);
  expect(all.some((node) => node.props.className === accountTileGrid)).toBe(true);
  const tile = all.find((node) => node.type === "button")!;
  expect(tile.props.className).toBe(accountTileClass);
  let html = renderToStaticMarkup(tree);
  expect(html).toContain("Example Bank · •••• 1234");
  expect(html).toContain('href="/benefits?year=2025"');
  expect(html).toContain("近 12 月");
  expect(html).not.toContain('role="dialog"');
  tile.props.onClick!();
  tree = view(() => BenefitOverview({ data }));
  html = renderToStaticMarkup(tree);
  expect(html).toContain('role="dialog"');
  expect(html).toContain("2 次");
  expect(html).toContain("最近 2026-10-22");
  expect(html).toContain("/activity?entryId=synthetic-entry");
  expect(html).not.toContain("/activity?entryId=old-entry");
  elements(tree).find((node) => node.type === FormSheet)!.props.onOpenChange!(false);
  expect(renderToStaticMarkup(view(() => BenefitOverview({ data })))).not.toContain('role="dialog"');
});
it("puts 卡权益 immediately after 账户 in navigation", () => {
  const html = renderToStaticMarkup(<AppNavigation />);
  expect(html.indexOf('href="/accounts"')).toBeLessThan(html.indexOf('href="/benefits"'));
  expect(html.indexOf('href="/benefits"')).toBeLessThan(html.indexOf('href="/investments"'));
  expect(html).toContain("卡权益");
});
it("healthy connection is collapsed with an independent sync action, and disclosure toggles", () => {
  const onSync = vi.fn();
  const props = { connection, timezone: "UTC", pending: false, onSync, children: <p>账户映射与历史</p> };
  let tree = view(() => ConnectionDisclosure(props));
  let all = elements(tree);
  const toggle = all.find((node) => node.props["aria-expanded"] !== undefined)!;
  expect(toggle.props["aria-expanded"]).toBe(false);
  expect(all.some((node) => node.props.hidden === true)).toBe(true);
  let html = renderToStaticMarkup(tree);
  expect(html).toContain("正常");
  expect(html).toContain("上次成功：");
  expect(html).toContain("1 个已映射账户");
  all.find((node) => node.props.onClick === onSync)!.props.onClick!();
  expect(onSync).toHaveBeenCalledOnce();
  toggle.props.onClick!();
  tree = view(() => ConnectionDisclosure(props));
  all = elements(tree);
  expect(all.some((node) => node.props["aria-expanded"] === true)).toBe(true);
  expect(all.some((node) => node.props.hidden === false)).toBe(true);
  html = renderToStaticMarkup(tree);
  expect(html).toContain("账户映射与历史");
  expect(html).toContain("min-w-0");
  expect(html).toContain("flex-wrap");
  expect(html).toContain("break-words");
});
it.each(["error", "login_required", "consent_expiring"] as const)(
  "opens connections needing %s attention",
  (status) => {
    const value = { ...connection, status };
    expect(connectionNeedsAttention(value)).toBe(true);
    const html = renderToStaticMarkup(
      <ConnectionDisclosure connection={value} timezone="UTC" pending={false} onSync={() => {}}>
        映射
      </ConnectionDisclosure>,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(status === "error" ? "错误" : "需要重新授权");
  },
);
it("opens missing mappings but does not nag for deliberately ignored accounts", () => {
  expect(connectionNeedsAttention({ ...connection, mappingConfirmedAt: null })).toBe(true);
  expect(connectionNeedsAttention({ ...connection, errorCode: "SYNTHETIC_ERROR" })).toBe(true);
  expect(
    connectionNeedsAttention({ ...connection, accounts: [{ ...connection.accounts[0], accountId: null }] }),
  ).toBe(true);
  expect(
    connectionNeedsAttention({
      ...connection,
      accounts: [{ ...connection.accounts[0], type: "investment" }],
    }),
  ).toBe(true);
  expect(
    connectionNeedsAttention({
      ...connection,
      accounts: [{ ...connection.accounts[0], accountId: null, isEnabled: false }],
    }),
  ).toBe(false);
});
