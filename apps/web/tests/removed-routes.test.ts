import { expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { proxy } from "@/proxy";
import { NextRequest } from "next/server";

it("removes page/API route files so authenticated requests fall through to Next's 404", async () => {
  const files = await readdir("app", { recursive: true });
  const routes = files
    .filter((file) => /(?:page|route)\.tsx?$/.test(file))
    .map(
      (file) =>
        `/${file
          .replaceAll("\\", "/")
          .split("/")
          .filter((part) => !part.startsWith("("))
          .join("/")
          .replace(/\/(?:page|route)\.tsx?$/, "")}`,
    );
  for (const prefix of [
    "/snapshots",
    "/reconciliation",
    "/api/snapshots",
    "/api/reconciliation",
    "/api/legacy-imports",
    "/api/account-groups",
    "/api/loyalty/legacy",
  ]) {
    expect(
      routes.filter((route) => route === prefix || route.startsWith(`${prefix}/`)),
      prefix,
    ).toEqual([]);
    const response = proxy(
      new NextRequest(`http://localhost:3000${prefix}`, { headers: { cookie: "al_session=synthetic" } }),
    );
    expect(response.headers.get("x-middleware-next")).toBe("1");
  }
  expect(routes.some((route) => route.includes("[..."))).toBe(false);
  expect(routes).toContain("/api/accounts/[id]/balance");
  // Authentication remains global; no special removed-route bypass is introduced.
  expect(proxy(new NextRequest("http://localhost:3000/snapshots")).status).toBe(307);
  const navigation = await readFile("components/app-navigation.tsx", "utf8");
  expect(navigation).not.toMatch(/\/snapshots|\/reconciliation/);
});
