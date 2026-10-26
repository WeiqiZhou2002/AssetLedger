import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  useState,
  type ReactNode,
  type ComponentProps,
  type FormEvent,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sql } from "drizzle-orm";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { rewardsOverview, type RewardsOverview } from "@/lib/rewards/queries";
import { saveLoyaltyAccount } from "@/lib/rewards/service";
import { RewardsView } from "@/components/rewards/view";
import { RewardEditor } from "@/components/rewards/forms";
import { DeleteRewardAccount } from "@/components/rewards/delete-account";
import { api } from "@/components/ledger/forms";
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: vi.fn(actual.useState) };
});
vi.mock("@/components/ledger/forms", async (original) => {
  const actual = await original<typeof import("@/components/ledger/forms")>();
  return {
    ...actual,
    api: vi.fn(),
    FormSheet: ({ children, title }: ComponentProps<typeof actual.FormSheet>) => (
      <section role="dialog" aria-label={title}>
        {children}
      </section>
    ),
  };
});
const realReact = await vi.importActual<typeof import("react")>("react");
let h: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
let data: RewardsOverview;
let state: unknown[];
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.client.close();
});
beforeEach(async () => {
  vi.clearAllMocks();
  state = [];
  await h.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(h.db);
  data = await rewardsOverview(h.db, f.ownerId, "2026-10-24");
});
afterEach(() => vi.unstubAllGlobals());
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
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
};
function elements(node: ReactNode): React.ReactElement<Props>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Props>(child) ? [child, ...elements(child.props.children)] : [],
  );
}
function button(tree: ReactNode, text: string) {
  return elements(tree).find((node) => node.props.onClick && renderToStaticMarkup(node).includes(text))!;
}
it("starts with an empty state, hides unowned catalog/CPP rows, and opens the program dropdown", () => {
  let tree = view(() => RewardsView({ data, cards: [] }));
  const html = renderToStaticMarkup(tree);
  expect(html).toContain("还没有积分账户");
  expect(html).toContain("添加积分账户");
  expect(html).not.toContain("点数 × CPP ÷ 100");
  for (const program of data.programs) expect(html).not.toContain(program.name);
  button(tree, "CPP 估值历史").props.onClick!();
  tree = view(() => RewardsView({ data, cards: [] }));
  expect(renderToStaticMarkup(tree)).not.toContain("1970-01-01");
  button(tree, "添加积分账户").props.onClick!();
  tree = view(() => RewardsView({ data, cards: [] }));
  const form = renderToStaticMarkup(tree);
  expect(form).toContain("MR · Amex Membership Rewards");
  expect(form).toContain('name="programId"');
});
it("submits the chosen program and existing account fields through the add form", async () => {
  const program = data.programs.find((row) => row.code === "MR")!;
  const closed = vi.fn();
  const fields = new FormData();
  fields.set("programId", program.id);
  fields.set("name", "Demo MR");
  fields.set("memberLast4", "1234");
  fields.set("linkedCardAccountId", f.card.id);
  fields.set("isActive", "true");
  const tree = view(() =>
    RewardEditor({
      form: { kind: "account" },
      data,
      cards: [{ id: f.card.id, name: "Demo Card" }],
      onClose: closed,
    }),
  );
  vi.mocked(api).mockImplementation(async (_path, _method, input) =>
    saveLoyaltyAccount(h.db, f.ownerId, input),
  );
  vi.stubGlobal(
    "FormData",
    class {
      constructor() {
        return fields;
      }
    },
  );
  elements(tree).find((node) => node.type === "form")!.props.onSubmit!({
    preventDefault: vi.fn(),
    currentTarget: {},
  } as unknown as FormEvent<HTMLFormElement>);
  await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
  expect(api).toHaveBeenCalledWith("/api/loyalty/accounts", "POST", {
    programId: program.id,
    name: "Demo MR",
    memberLast4: "1234",
    linkedCardAccountId: f.card.id,
    notes: null,
    isActive: true,
  });
  data = await rewardsOverview(h.db, f.ownerId, data.asOf);
  const html = renderToStaticMarkup(<RewardsView data={data} cards={[]} />);
  expect(html).toContain("Amex Membership Rewards");
  expect(html).not.toContain("Chase Ultimate Rewards");
});
it.each([true, false])(
  "previews counts and explains whole-transfer removal; confirm=%s",
  async (confirmed) => {
    const counts = { events: 5, observations: 2, transfers: 2, otherAccountEvents: 2 };
    const confirm = vi.fn<(message: string) => boolean>(() => confirmed);
    vi.stubGlobal("window", { confirm });
    vi.mocked(api).mockResolvedValue(counts);
    const deleted = vi.fn();
    const tree = view(() => DeleteRewardAccount({ accountId: "synthetic", onDeleted: deleted }));
    button(tree, "删除").props.onClick!();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(confirm.mock.calls[0]?.[0]).toContain("5 条积分事件、2 条余额观察和 2 笔转点");
    expect(confirm.mock.calls[0]?.[0]).toContain("对方账户的 2 条事件，对方余额将重新计算");
    if (confirmed) {
      await vi.waitFor(() => expect(deleted).toHaveBeenCalledOnce());
      expect(api).toHaveBeenLastCalledWith("/api/loyalty/accounts/synthetic", "DELETE", counts);
      expect(refresh).toHaveBeenCalledOnce();
    } else {
      expect(api).toHaveBeenCalledTimes(1);
      expect(deleted).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    }
  },
);
it("shows preview errors and preserves the account without issuing DELETE", async () => {
  vi.mocked(api).mockRejectedValue(new Error("预览失败"));
  const deleted = vi.fn();
  const props = { accountId: "synthetic", onDeleted: deleted };
  button(
    view(() => DeleteRewardAccount(props)),
    "删除",
  ).props.onClick!();
  await vi.waitFor(() =>
    expect(renderToStaticMarkup(view(() => DeleteRewardAccount(props)))).toContain("预览失败"),
  );
  expect(api).toHaveBeenCalledTimes(1);
  expect(deleted).not.toHaveBeenCalled();
});

it("offers archived programs in the add dropdown and explains that adding restores the selected program", () => {
  const archived = data.programs.find((row) => row.code === "MR")!;
  archived.isArchived = true;
  const html = renderToStaticMarkup(
    <RewardEditor
      form={{ kind: "account", programId: archived.id }}
      data={data}
      cards={[]}
      onClose={() => {}}
    />,
  );
  expect(html).toContain("MR · Amex Membership Rewards · 已归档");
  expect(html).toContain("添加账户会恢复此项目，保留原有 CPP 历史。");
  expect(html).toContain(`value="${archived.id}"`);
});
