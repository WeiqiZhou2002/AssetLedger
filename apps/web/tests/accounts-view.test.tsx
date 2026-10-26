import { accountBalanceTracking } from "@/lib/ledger/balance-tracking";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { Children, isValidElement, useState, type ReactNode, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq, sql } from "drizzle-orm";
import { AccountsView } from "@/components/ledger/accounts-view";
import { AccountCard } from "@/components/ledger/account-card";
import { Button } from "@/components/ui/button";
import { FormSheet, api } from "@/components/ledger/forms";
import { balancesAsOf } from "@/lib/ledger/queries";
import { accountPositions } from "@/lib/ledger/observed-balances";
import { createQuickEntry } from "@/lib/ledger/builders";
import { updateAccount } from "@/lib/ledger/accounts";
import { createSnapshot, publishSnapshot } from "@/lib/snapshots/service";
import { balanceSnapshots } from "@/db/schema";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: vi.fn(actual.useState) };
});
vi.mock("@/components/ledger/forms", async (original) => {
  const actual = await original<typeof import("@/components/ledger/forms")>();
  return {
    ...actual,
    // Node tests render sheet contents without Radix's browser portal.
    FormSheet: ({ open, title, children }: ComponentProps<typeof actual.FormSheet>) =>
      open ? (
        <section role="dialog" aria-label={title}>
          {children}
        </section>
      ) : null,
    api: vi.fn(async () => ({})),
    useLedgerMutation: () => ({
      pending: false,
      error: "",
      run: (operation: () => Promise<void>) => operation(),
    }),
  };
});
const realReact = await vi.importActual<typeof import("react")>("react");
let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
let props: ComponentProps<typeof AccountsView>;
let state: unknown[];
const today = "2026-10-25";

// Exercise the real tile/action callbacks and rerender with fresh server props.
// Child components retain real React hooks; only the view's two state slots are controlled here.
function view() {
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
    return AccountsView(props);
  } finally {
    vi.mocked(useState).mockImplementation(realReact.useState);
  }
}
type ElementProps = {
  children?: ReactNode;
  id?: string;
  title?: string;
  onClick?: () => unknown;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};
function nodes(tree: ReactNode): React.ReactElement<ElementProps>[] {
  return Children.toArray(tree).flatMap((child) =>
    isValidElement<ElementProps>(child) ? [child, ...nodes(child.props.children)] : [],
  );
}
function clickTile(accountId: string) {
  const tile = nodes(view()).find(
    (node) => node.type === "button" && node.props.id === `account-${accountId}`,
  )!;
  tile.props.onClick!();
  return view();
}
function detailSheet(tree: ReactNode) {
  return nodes(tree).find((node) => node.type === FormSheet && node.props.open)!;
}
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.client.close();
});
beforeEach(async () => {
  state = [];
  vi.clearAllMocks();
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
  await updateAccount(h.db, f.ownerId, f.card.id, {
    last4: "1234",
    name: "Demo Card 1234 with a very long account name",
  });
  await createQuickEntry(h.db, f.ownerId, {
    type: "expense",
    fromAccountId: f.card.id,
    amount: "30",
    categoryId: f.category("餐饮"),
    eventDate: "2026-10-19",
  });
  const snapshot = await createSnapshot(h.db, f.ownerId, {
    snapshotDate: "2026-10-20",
    label: "Synthetic card observation",
    items: [{ accountId: f.card.id, balanceNative: "-200", currency: "USD" }],
  });
  await publishSnapshot(h.db, f.ownerId, snapshot.id);
  const bank = await createSnapshot(h.db, f.ownerId, {
    snapshotDate: today,
    label: "Synthetic bank observation",
    items: [
      {
        accountId: f.bank.id,
        balanceNative: "700",
        currency: "USD",
        sourceRef: "synthetic:2026-10-25T21:02:00Z",
      },
    ],
  });
  await publishSnapshot(h.db, f.ownerId, bank.id);
  await h.db.update(balanceSnapshots).set({ source: "plaid" }).where(eq(balanceSnapshots.id, bank.id));
  props = {
    accounts: await balancesAsOf(h.db, f.ownerId, today),
    institutions: [],
    groups: [],
    today,
    positions: (await accountPositions(h.db, f.ownerId, today, { includeSuggestions: false })).map(
      ({ account, observed, difference }) => ({ accountId: account.id, observed, difference }),
    ),
    timezone: "America/Los_Angeles",
    totpEnabled: true,
    cards: [
      {
        accountId: f.card.id,
        network: "visa",
        numberLast4: "1234",
        hasExpiry: true,
        hasCvv: true,
        hasCid: false,
      },
    ],
  };
});
it("renders compact accessible tiles with only identity, observed balance, time and responsive columns", () => {
  const tree = view();
  const tile = nodes(tree).find((node) => node.props.id === `account-${f.card.id}`)!;
  const html = renderToStaticMarkup(tile);
  const text = html.replace(/<[^>]*>/g, "");
  expect(text).toBe("Demo Card 1234 with a very long account name•••• 1234USD -200.00手工 10-20");
  expect(html).toContain('type="button"');
  expect(html).toContain('aria-label="查看 Demo Card 1234 with a very long account name 详情"');
  expect(html).toContain('title="Demo Card 1234 with a very long account name"');
  expect(html).toContain("truncate");
  expect(html).toContain("focus-visible:ring-2");
  expect(html).toContain("whitespace-nowrap");
  expect(html).toContain("1.5rem");
  expect(html).not.toMatch(/<a |<input |账本余额|卡片信息|纳入|卡权益返还|编辑账户/);
  expect(html.match(/<button /g)).toHaveLength(1);
  const page = renderToStaticMarkup(tree);
  expect(page).toContain("grid-cols-1");
  expect(page).toContain("sm:grid-cols-2");
  expect(page).toContain("lg:grid-cols-3");
  expect(page).toContain("Plaid 10-25 14:02");
  expect(page).not.toContain("期初");
  expect(page).not.toContain('role="dialog"');
});
it("opens credit details in order with unchanged card controls and benefits", () => {
  const tree = clickTile(f.card.id);
  const sheet = detailSheet(tree);
  const html = renderToStaticMarkup(sheet);
  const headings = [...html.matchAll(/<h[34][^>]*>(.*?)<\/h[34]>/g)].map((match) => match[1]);
  expect(headings).toEqual(["余额", "卡片信息", "卡权益返还", "最近流水"]);
  expect(html).toContain("账本比观察多");
  expect(html).toContain("170.00");
  expect(html).not.toContain('href="/reconciliation"');
  expect(html).toContain('href="/benefits"');
  expect(html).toContain("本年");
  expect(html).toContain("近 12 月");
  expect(html).toContain("Visa •••• 1234");
  for (const label of ["更新", "查看", "删除", "编辑账户", "停用"]) expect(html).toContain(label);
  const card = nodes(tree).find((node) => node.type === AccountCard)!;
  expect(card.props).toMatchObject({ account: { id: f.card.id }, totpEnabled: true });
  expect(html).not.toContain("期初");
});
it("opens cash card controls, shows bank and ledger balances, and omits credit-only benefits", () => {
  const html = renderToStaticMarkup(detailSheet(clickTile(f.bank.id)));
  expect(html).toContain("银行余额");
  expect(html).toContain("Plaid 2026-10-25 14:02");
  expect(html).toContain("账本余额");
  expect(html).toContain("账本比观察少");
  expect(html).toContain("卡片信息");
  expect(html).toContain("保存");
  expect(html).not.toContain("卡权益返还");
});
it("uses ledger balances without observations and omits card controls for unsupported accounts", () => {
  const tile = nodes(view()).find((node) => node.props.id === `account-${f.broker.id}`)!;
  expect(renderToStaticMarkup(tile).replace(/<[^>]*>/g, "")).toBe("Demo Brokerage CashUSD 0.00账本");
  const html = renderToStaticMarkup(detailSheet(clickTile(f.broker.id)));
  expect(html).toContain("账本余额");
  expect(html).not.toMatch(/卡片信息|卡权益返还|进入对账/);
});
it("keeps details fresh by id after refresh and supports disable/re-enable and inactive badges", async () => {
  clickTile(f.bank.id);
  const deactivate = nodes(view()).find((node) => node.type === Button && node.props.children === "停用")!;
  await deactivate.props.onClick!();
  expect(api).toHaveBeenCalledWith(`/api/accounts/${f.bank.id}`, "PATCH", { isActive: false });
  await updateAccount(h.db, f.ownerId, f.bank.id, { name: "Updated Example Checking", isActive: false });
  await createQuickEntry(h.db, f.ownerId, {
    type: "income",
    toAccountId: f.bank.id,
    amount: "50",
    categoryId: f.category("工资"),
    eventDate: today,
  });
  const refreshed = await createSnapshot(h.db, f.ownerId, {
    snapshotDate: today,
    label: "Updated synthetic balance",
    items: [{ accountId: f.bank.id, balanceNative: "900", currency: "USD" }],
  });
  await publishSnapshot(h.db, f.ownerId, refreshed.id);
  props = {
    ...props,
    accounts: await balancesAsOf(h.db, f.ownerId, today),
    positions: (await accountPositions(h.db, f.ownerId, today, { includeSuggestions: false })).map(
      ({ account, observed, difference }) => ({ accountId: account.id, observed, difference }),
    ),
  };
  const tree = view();
  const sheet = detailSheet(tree);
  expect(sheet.props.title).toBe("Updated Example Checking");
  const html = renderToStaticMarkup(sheet);
  expect(html).toContain("900.00");
  expect(html).toContain("850.00");
  expect(html).toContain("50.00");
  expect(html).toContain("重新启用");
  const tiles = nodes(tree)
    .filter((node) => node.type === "button")
    .map((node) => renderToStaticMarkup(node));
  expect(tiles.filter((tile) => tile.includes("已停用"))).toHaveLength(1);
  const activate = nodes(tree).find((node) => node.type === Button && node.props.children === "重新启用")!;
  await activate.props.onClick!();
  expect(api).toHaveBeenLastCalledWith(`/api/accounts/${f.bank.id}`, "PATCH", { isActive: true });
});
it("closes details before editing and clears the selected account on dismissal", () => {
  const tree = clickTile(f.bank.id);
  const edit = nodes(tree).find(
    (node) => node.type === Button && renderToStaticMarkup(node).includes("编辑账户"),
  )!;
  edit.props.onClick!();
  const editing = nodes(view()).filter((node) => node.type === FormSheet && node.props.open);
  expect(editing).toHaveLength(1);
  expect(editing[0].props.title).toBe("编辑账户");
  editing[0].props.onOpenChange!(false);
  const detail = detailSheet(clickTile(f.card.id));
  detail.props.onOpenChange!(false);
  expect(detailSheet(view())).toBeUndefined();
});
it("offers observation-based empty-state guidance without opening-balance copy", () => {
  props = { ...props, accounts: [] };
  const html = renderToStaticMarkup(view());
  expect(html).toContain("账户详情更新余额");
  expect(html).not.toContain("期初");
});

it("shows manual balance controls and reminder settings inside the account detail sheet", async () => {
  props.tracking = await accountBalanceTracking(h.db, f.ownerId, today);
  const html = renderToStaticMarkup(detailSheet(clickTile(f.card.id)));
  expect(html).toContain("更新余额");
  expect(html).toContain("余额更新提醒");
  expect(html).not.toMatch(/纳入口径|现金类已纳入|金融资产已纳入|\/reconciliation/);
});
