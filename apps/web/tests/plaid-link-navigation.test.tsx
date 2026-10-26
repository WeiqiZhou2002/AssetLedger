import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlaidLinkOptions } from "react-plaid-link";
import { LinkLaunch, LINK_STORAGE } from "@/components/bank-sync/link";

const { router, request, removeItem } = vi.hoisted(() => ({
  router: { push: vi.fn(), refresh: vi.fn(), replace: vi.fn() },
  request: vi.fn(),
  removeItem: vi.fn(),
}));
let options: PlaidLinkOptions;
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/ledger/forms", () => ({ api: request }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("react-plaid-link", () => ({
  usePlaidLink: (value: PlaidLinkOptions) => {
    options = value;
    return { ready: false, open: vi.fn(), exit: vi.fn(), error: null };
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
