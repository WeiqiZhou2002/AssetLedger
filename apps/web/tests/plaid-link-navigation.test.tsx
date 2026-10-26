import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlaidLinkOptions } from "react-plaid-link";
import { LinkLaunch, LINK_STORAGE } from "@/components/bank-sync/link";
import { DuplicateChoices } from "@/components/bank-sync/duplicate-choices";

const { router, request, removeItem, exit } = vi.hoisted(() => ({
  router: { push: vi.fn(), refresh: vi.fn(), replace: vi.fn() },
  request: vi.fn(),
  removeItem: vi.fn(),
  exit: vi.fn(),
}));
let options: PlaidLinkOptions;
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/ledger/forms", () => ({ api: request }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("react-plaid-link", () => ({
  usePlaidLink: (value: PlaidLinkOptions) => {
    options = value;
    return { ready: false, open: vi.fn(), exit, error: null };
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  request.mockResolvedValue({ connection: { id: "synthetic-connection" } });
  vi.stubGlobal("sessionStorage", { removeItem });
  vi.stubGlobal("window", {
    location: { href: "https://example.test/plaid/oauth?oauth_state_id=synthetic" },
  });
});

it("requires an explicit duplicate choice and bypasses the guard for only that Link session", async () => {
  const duplicate = vi.fn();
  const done = vi.fn();
  const session = { token: "link-synthetic", expiration: "2030-01-01T00:00:00Z" };
  const existing = [{ id: "synthetic-connection", institutionId: "ins_synthetic" }];
  const metadata = { institution_id: "ins_synthetic" } as Parameters<
    NonNullable<PlaidLinkOptions["onEvent"]>
  >[1];
  renderToStaticMarkup(
    <LinkLaunch session={session} existing={existing} onDuplicate={duplicate} onDone={done} />,
  );
  options.onEvent?.("SELECT_INSTITUTION", metadata);
  expect(exit).toHaveBeenCalledWith({ force: true });
  expect(duplicate).toHaveBeenCalledWith("synthetic-connection");
  const choices = renderToStaticMarkup(
    <DuplicateChoices pending={false} onAdd={() => {}} onReauthorize={() => {}} />,
  );
  expect(choices).toContain("重新授权已有连接");
  expect(choices).toContain("仍然添加新连接（会占用一个新的 Plaid Item）");
  vi.clearAllMocks();
  renderToStaticMarkup(
    <LinkLaunch
      session={{ ...session, allowDuplicate: true }}
      existing={existing}
      onDuplicate={duplicate}
      onDone={done}
    />,
  );
  options.onEvent?.("SELECT_INSTITUTION", metadata);
  expect(exit).not.toHaveBeenCalled();
  expect(duplicate).not.toHaveBeenCalled();
  options.onSuccess("public-synthetic", {
    institution: { institution_id: "ins_synthetic", name: "Example Bank" },
    accounts: [],
    link_session_id: "synthetic-session",
  });
  await vi.waitFor(() => expect(done).toHaveBeenCalled());
  expect(request).toHaveBeenCalledWith(
    "/api/plaid/exchange",
    "POST",
    expect.objectContaining({ allowDuplicate: true }),
  );
  expect(removeItem).toHaveBeenCalledWith(LINK_STORAGE);
  renderToStaticMarkup(
    <LinkLaunch session={session} existing={existing} onDuplicate={duplicate} onDone={done} />,
  );
  options.onEvent?.("SELECT_INSTITUTION", metadata);
  expect(duplicate).toHaveBeenCalledOnce();
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  { oauth: false, update: false },
  { oauth: true, update: false },
  { oauth: true, update: true },
])("lands Link success on its mapping card: OAuth $oauth, update $update", async ({ oauth, update }) => {
  const done = vi.fn();
  renderToStaticMarkup(
    <LinkLaunch
      oauth={oauth}
      session={{
        token: "link-sandbox-synthetic",
        expiration: "2030-01-01T00:00:00Z",
        ...(update ? { connectionId: "synthetic-connection" } : {}),
      }}
      onDone={done}
    />,
  );
  expect(options.token).toBe("link-sandbox-synthetic");
  if (oauth) expect(options).toHaveProperty("receivedRedirectUri", window.location.href);
  else expect(options).not.toHaveProperty("receivedRedirectUri");
  options.onSuccess("public-sandbox-synthetic", {
    institution: { institution_id: "ins_synthetic", name: "Example Bank" },
    accounts: [],
    link_session_id: "synthetic-session",
  });
  await vi.waitFor(() => expect(done).toHaveBeenCalledWith("synthetic-connection"));
  expect(router.push).toHaveBeenCalledWith(
    "/statements?tab=sync&connection=synthetic-connection#connection-synthetic-connection",
  );
  expect(removeItem).toHaveBeenCalledWith(LINK_STORAGE);
  expect(request.mock.calls[0][0]).toBe(
    update ? "/api/plaid/connections/synthetic-connection/reauth" : "/api/plaid/exchange",
  );
  expect(router.replace).not.toHaveBeenCalled();
});
