import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountChangeCard } from "@/components/dashboard/account-change-card";
import { ConnectionsView } from "@/components/bank-sync/connections-view";
import { RecentAutoPosts } from "@/components/bank-sync/recent-auto-posts";
import { FormSheet } from "@/components/ledger/forms";
import { exchangeConnection, listConnections, saveMapping } from "@/lib/bank-sync/connections";
import { syncConnection } from "@/lib/bank-sync/sync";
import { pendingWorkbench } from "@/lib/bank-sync/pending";
import { jsonSafe } from "@/lib/serialization";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { FakePlaid, bankTransaction, plaidConfig } from "./helpers/plaid";

const { router, fetchMock, target, getElementById, setItem } = vi.hoisted(() => {
  const target = { scrollIntoView: vi.fn(), focus: vi.fn() };
  return {
    router: { replace: vi.fn(), refresh: vi.fn() },
    fetchMock: vi.fn(),
    target,
    getElementById: vi.fn(() => target),
    setItem: vi.fn(),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: vi.fn(actual.useState),
    useRef: vi.fn(actual.useRef),
    useEffect: vi.fn(actual.useEffect),
  };
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
let effects: (() => void | (() => void))[];
let h: Awaited<ReturnType<typeof createTestDb>>;
let connection: ComponentProps<typeof ConnectionsView>["connections"][number];
let entries: ComponentProps<typeof RecentAutoPosts>["entries"];

// Follow the existing UI tests: invoke handlers with persistent hook state and render real child markup.
function view<T>(render: () => T) {
  let cursor = 0;
  effects = [];
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
  vi.mocked(useRef).mockImplementation(<T,>(initial: T) => {
    const index = cursor++;
    if (!(index in state)) state[index] = { current: initial };
    return state[index] as { current: T };
  });
  vi.mocked(useEffect).mockImplementation((effect) => {
    effects.push(effect);
  });
  try {
    return render();
  } finally {
    vi.mocked(useState).mockImplementation(realReact.useState);
    vi.mocked(useRef).mockImplementation(realReact.useRef);
    vi.mocked(useEffect).mockImplementation(realReact.useEffect);
  }
}
type Props = {
  children?: ReactNode;
  onClick?: () => void;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  title?: string;
  hidden?: boolean;
  "aria-label"?: string;
  "aria-expanded"?: boolean;
};
function elements(node: ReactNode): React.ReactElement<Props>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Props>(child) ? [child, ...elements(child.props.children)] : [],
  );
}
const summaries = [
  {
    id: "synthetic-new",
    institutionName: "Example Bank",
    newAccountsAvailable: true,
    unmappedNewAccounts: 0,
    unsharedMapped: 0,
  },
  {
    id: "synthetic-mapping",
    institutionName: "Demo Bank",
    newAccountsAvailable: false,
    unmappedNewAccounts: 2,
    unsharedMapped: 0,
  },
  {
    id: "synthetic-unshared",
    institutionName: "Fictional Bank",
    newAccountsAvailable: false,
    unmappedNewAccounts: 0,
    unsharedMapped: 3,
  },
];
const props = (): ComponentProps<typeof ConnectionsView> => ({
  connections: [connection],
  accounts: [],
  environment: "sandbox",
  interval: 12,
  timezone: "UTC",
  targetConnectionId: connection.id,
  selectAccounts: true,
});
function location(query: string) {
  vi.stubGlobal("window", { location: { href: `https://example.test/statements?${query}` } });
}
const sheet = (tree: ReactNode) =>
  elements(tree).find((node) => node.type === FormSheet && node.props.title === "添加或移除账户")!;

beforeAll(async () => {
  h = await createTestDb();
  const f = await ledgerFixture(h.db);
  const client = new FakePlaid();
  const now = new Date("2026-11-05T12:00:00Z");
  const linked = await exchangeConnection(
    h.db,
    f.ownerId,
    client,
    plaidConfig,
    {
      public_token: "synthetic-public",
      institution: { name: "Example Bank", institution_id: "synthetic-bank" },
    },
    now,
  );
  await saveMapping(
    h.db,
    f.ownerId,
    linked.connection.id,
    plaidConfig,
    {
      importFromDate: linked.connection.importFromDate,
      accounts: linked.accounts.map((row) => ({
        id: row.id,
        accountId: row.type === "credit" ? f.card.id : f.bank.id,
        isEnabled: true,
      })),
    },
    now,
  );
  client.page = () => ({
    accounts: client.accountRows,
    added: [bankTransaction("synthetic-recent")],
    modified: [],
    removed: [],
    nextCursor: "synthetic",
    hasMore: false,
    updateStatus: "HISTORICAL_UPDATE_COMPLETE",
  });
  await syncConnection(h.db, f.ownerId, linked.connection.id, client, plaidConfig, now);
  [connection] = jsonSafe(await listConnections(h.db, f.ownerId, plaidConfig));
  entries = jsonSafe((await pendingWorkbench(h.db, f.ownerId, "sandbox")).recent);
});
afterAll(async () => {
  await h.client.close();
});
beforeEach(() => {
  state = [];
  effects = [];
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("document", { getElementById });
  vi.stubGlobal("sessionStorage", { setItem });
  fetchMock.mockResolvedValue(Response.json({ ok: true }));
  location(`tab=sync&connection=${connection.id}&select=accounts&keep=synthetic#connection-${connection.id}`);
});
afterEach(() => vi.unstubAllGlobals());

it("renders one institution row per summary, all three cases and exact action links", () => {
  const tree = view(() => AccountChangeCard({ summaries }));
  const html = renderToStaticMarkup(tree);
  expect(elements(tree).filter((node) => node.type === "li")).toHaveLength(3);
  for (const text of [
    "银行账户有变化",
    "Example Bank 有新账户可以添加",
    "Demo Bank 发现 2 个新账户，确认映射后开始同步",
    "Fictional Bank 3 个账户已停止共享，不再同步",
  ])
    expect(html).toContain(text);
  expect(html).toContain(
    'href="/statements?tab=sync&amp;connection=synthetic-new&amp;select=accounts#connection-synthetic-new"',
  );
  expect(html).toContain(
    'href="/statements?tab=sync&amp;connection=synthetic-mapping#mapping-synthetic-mapping"',
  );
  expect(html).toContain(
    'href="/statements?tab=sync&amp;connection=synthetic-unshared#connection-synthetic-unshared"',
  );
});
it("keeps simultaneous cases in one institution row and omits the card for no summaries", () => {
  const tree = view(() =>
    AccountChangeCard({ summaries: [{ ...summaries[0], unmappedNewAccounts: 2, unsharedMapped: 1 }] }),
  );
  expect(elements(tree).filter((node) => node.type === "li")).toHaveLength(1);
  expect(renderToStaticMarkup(tree)).toContain("确认映射");
  expect(renderToStaticMarkup(tree)).toContain("查看");
  expect(view(() => AccountChangeCard({ summaries: [] }))).toBeNull();
});
it.each([true, false])(
  "dismisses through the existing route and refreshes only on success (%s)",
  async (success) => {
    fetchMock.mockResolvedValue(
      Response.json(success ? { ok: true } : { error: "暂时无法保存" }, { status: success ? 200 : 503 }),
    );
    const tree = view(() => AccountChangeCard({ summaries }));
    elements(tree).find((node) => node.props["aria-label"] === "Example Bank：暂不添加")!.props.onClick!();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/plaid/connections/synthetic-new/dismiss-new-accounts",
      expect.objectContaining({ method: "POST" }),
    );
    if (success) await vi.waitFor(() => expect(router.refresh).toHaveBeenCalledOnce());
    else {
      await vi.waitFor(() =>
        expect(renderToStaticMarkup(view(() => AccountChangeCard({ summaries })))).toContain("暂时无法保存"),
      );
      expect(router.refresh).not.toHaveBeenCalled();
    }
  },
);
it("opens the selection confirmation once, consumes only select, and waits for the owner's next click", async () => {
  let tree = view(() => ConnectionsView(props()));
  expect(sheet(tree).props.open).toBe(true);
  const mountedEffects = [...effects];
  mountedEffects.forEach((effect) => effect());
  mountedEffects.forEach((effect) => effect()); // StrictMode effect replay must not consume twice.
  expect(router.replace).toHaveBeenCalledExactlyOnceWith(
    `/statements?tab=sync&connection=${connection.id}&keep=synthetic#connection-${connection.id}`,
    { scroll: false },
  );
  expect(fetchMock).not.toHaveBeenCalled();
  sheet(tree).props.onOpenChange!(false);
  tree = view(() => ConnectionsView(props()));
  effects.forEach((effect) => effect());
  expect(sheet(tree).props.open).toBe(false);
  expect(router.replace).toHaveBeenCalledOnce();
  state = [];
  location(`tab=sync&connection=${connection.id}#connection-${connection.id}`);
  tree = view(() => ConnectionsView({ ...props(), selectAccounts: false }));
  expect(sheet(tree).props.open).toBe(false);
  state = [];
  tree = view(() => ConnectionsView(props()));
  fetchMock.mockResolvedValue(
    Response.json({ link_token: "link-synthetic", expiration: "2030-01-01T00:00:00Z" }),
  );
  elements(sheet(tree).props.children).find((node) => node.props.onClick)!.props.onClick!();
  await vi.waitFor(() => expect(setItem).toHaveBeenCalledOnce());
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/plaid/connections/${connection.id}/link-token`,
    expect.objectContaining({ method: "POST", body: JSON.stringify({ accountSelection: true }) }),
  );
});
it.each(["unknown", "revoked", "production", "login_required"])(
  "ignores %s selection targets while consuming select",
  (kind) => {
    const input = props();
    if (kind === "unknown") input.targetConnectionId = "unknown-id";
    else
      input.connections = [
        {
          ...connection,
          ...(kind === "production"
            ? { environment: "production" as const }
            : { status: kind as "revoked" | "login_required" }),
        },
      ];
    location(
      `tab=sync&connection=${input.targetConnectionId}&select=accounts#connection-${input.targetConnectionId}`,
    );
    const tree = view(() => ConnectionsView(input));
    expect(sheet(tree).props.open).toBe(false);
    effects.forEach((effect) => effect());
    expect(router.replace).toHaveBeenCalledExactlyOnceWith(
      `/statements?tab=sync&connection=${input.targetConnectionId}#connection-${input.targetConnectionId}`,
      { scroll: false },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  },
);
it.each(["mapping", "connection"])("expands a healthy target and lands on its %s anchor", (anchor) => {
  location(`tab=sync&connection=${connection.id}#${anchor}-${connection.id}`);
  const tree = view(() => ConnectionsView({ ...props(), selectAccounts: false }));
  const html = renderToStaticMarkup(tree);
  expect(html).toContain(`id="${anchor}-${connection.id}"`);
  expect(html).toContain('aria-expanded="true"');
  expect(html).not.toContain(`id="connection-details-${connection.id}" hidden`);
  effects.forEach((effect) => effect());
  expect(getElementById).toHaveBeenCalledWith(`${anchor}-${connection.id}`);
  expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(router.replace).not.toHaveBeenCalled();
});
it.each([true, false])(
  "recent auto-posts start collapsed and expand with their list or empty text (%s)",
  (hasEntries) => {
    expect(entries.length).toBeGreaterThan(0);
    const input = { entries: hasEntries ? entries : [] };
    let tree = view(() => RecentAutoPosts(input));
    let toggle = elements(tree).find((node) => node.props["aria-expanded"] !== undefined)!;
    expect(toggle.props["aria-expanded"]).toBe(false);
    expect(elements(tree).some((node) => node.props.hidden === true)).toBe(true);
    const html = renderToStaticMarkup(tree);
    expect(html).toContain(hasEntries ? `最近自动入账 · ${entries.length} 笔` : "最近自动入账");
    if (!hasEntries) expect(html).not.toContain("0 笔");
    toggle.props.onClick!();
    tree = view(() => RecentAutoPosts(input));
    toggle = elements(tree).find((node) => node.props["aria-expanded"] !== undefined)!;
    expect(toggle.props["aria-expanded"]).toBe(true);
    expect(elements(tree).some((node) => node.props.hidden === false)).toBe(true);
    expect(renderToStaticMarkup(tree)).toContain(
      hasEntries ? `/activity?entryId=${entries[0].id}` : "同步完成后，已入账交易会显示在这里。",
    );
  },
);
