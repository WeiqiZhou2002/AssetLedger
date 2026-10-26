import { afterEach, expect, it, vi } from "vitest";
import { useEffect, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountRecent } from "@/components/ledger/account-recent";
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: vi.fn(actual.useState), useEffect: vi.fn(actual.useEffect) };
});
const react = await vi.importActual<typeof import("react")>("react");
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(useState).mockImplementation(react.useState);
  vi.mocked(useEffect).mockImplementation(react.useEffect);
});
function mount(accountId: string) {
  const state: unknown[] = [];
  let effect: (() => void | (() => void)) | undefined;
  function render() {
    let cursor = 0;
    vi.mocked(useState).mockImplementation(<S,>(initial?: S | (() => S)) => {
      const index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [
        state[index] as S,
        (value: S | ((previous: S) => S)) => {
          state[index] =
            typeof value === "function" ? (value as (previous: S) => S)(state[index] as S) : value;
        },
      ];
    });
    vi.mocked(useEffect).mockImplementation((callback) => {
      effect = callback;
    });
    const tree = AccountRecent({ accountId });
    vi.mocked(useState).mockImplementation(react.useState);
    vi.mocked(useEffect).mockImplementation(react.useEffect);
    return renderToStaticMarkup(tree);
  }
  const initial = render();
  const cleanup = effect?.();
  return { initial, render, cleanup };
}
it("fetches only the selected account on mount with stable-height loading and empty states", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ entries: [], total: 0, limit: 10, offset: 0 }),
  );
  vi.stubGlobal("fetch", fetcher);
  const view = mount("synthetic-card");
  expect(view.initial).toContain("正在加载流水…");
  expect(view.initial).toContain("h-72 min-w-0 overflow-y-auto");
  expect(fetcher).toHaveBeenCalledWith("/api/transactions?accountId=synthetic-card&limit=10", {
    cache: "no-store",
    signal: expect.any(AbortSignal),
  });
  await vi.waitFor(() => expect(view.render()).toContain("这个账户尚无流水。"));
  expect(view.render()).toContain('href="/activity?accountId=synthetic-card"');
  expect(view.render()).toContain("h-72 min-w-0 overflow-y-auto");
  view.cleanup?.();
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
});
it("shows a fixed-height error and keeps the all-activity fallback", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 500 })),
  );
  const view = mount("synthetic-cash");
  await vi.waitFor(() => expect(view.render()).toContain('role="alert"'));
  expect(view.render()).toContain("查看全部流水 →");
  expect(view.render()).toContain("h-72 min-w-0 overflow-y-auto");
  view.cleanup?.();
});
it("aborts on close and ignores a late response from the previous account", async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const first = mount("synthetic-first");
  first.cleanup?.();
  resolve(Response.json({ entries: [], total: 0, limit: 10, offset: 0 }));
  await new Promise((done) => setTimeout(done, 0));
  expect(first.render()).toContain("正在加载流水…");
  const second = mount("synthetic-second");
  expect(fetcher).toHaveBeenLastCalledWith("/api/transactions?accountId=synthetic-second&limit=10", {
    cache: "no-store",
    signal: expect.any(AbortSignal),
  });
  expect(second.initial).toContain("正在加载流水…");
  second.cleanup?.();
});
