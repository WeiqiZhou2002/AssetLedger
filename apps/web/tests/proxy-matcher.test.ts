import { expect, it } from "vitest";
import { config } from "@/proxy";

const matches = (path: string) => config.matcher.some((pattern) => new RegExp(`^${pattern}$`).test(path));

it("lets public icons and the manifest bypass the login redirect", () => {
  for (const path of [
    "/icon.svg",
    "/apple-icon.png",
    "/icons/icon-192.png",
    "/favicon.ico",
    "/manifest.webmanifest",
  ])
    expect(matches(path)).toBe(false);
});

it("still runs the proxy for app pages and APIs", () => {
  for (const path of ["/dashboard", "/login", "/accounts", "/api/health"]) expect(matches(path)).toBe(true);
});
