import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BrandLogo } from "@/components/brand-logo";
import { AppNavigation } from "@/components/app-navigation";
import Login from "@/app/(auth)/login/page";
import { metadata } from "@/app/layout";
import manifest from "@/app/manifest";
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/components/login-form", () => ({ LoginForm: () => <form aria-label="登录" /> }));
vi.mock("@/app/globals.css", () => ({}));

it("uses the same decorative ledger mark in desktop/mobile navigation and above the login title", () => {
  const mark = renderToStaticMarkup(<BrandLogo size={16} />);
  expect(mark).toContain('aria-hidden="true"');
  expect(mark).toContain('width="16"');
  const glyph = /d="([^"]+)"/.exec(mark)![1];
  const nav = renderToStaticMarkup(<AppNavigation />);
  const login = renderToStaticMarkup(<Login />);
  expect(nav.split(glyph)).toHaveLength(3);
  expect(login.split(glyph)).toHaveLength(3);
  expect(login.lastIndexOf(glyph)).toBeLessThan(login.indexOf("打开你的私人账簿"));
  expect(nav).not.toContain("lucide-wallet");
  expect(login).not.toContain("lucide-wallet");
  const svg = readFileSync(new URL("../app/icon.svg", import.meta.url), "utf8");
  expect(svg).toBe(readFileSync(new URL("../public/icons/icon.svg", import.meta.url), "utf8"));
  for (const path of mark.matchAll(/d="([^"]+)"/g)) expect(svg).toContain(`d="${path[1]}"`);
  for (const color of ["#213e35", "#f6f5f1", "#b8cc9d"]) expect(svg).toContain(color);
});
it("declares favicon and Apple metadata and ships the correct PWA and Apple raster dimensions", () => {
  expect(metadata.icons).toEqual({
    icon: { url: "/icon.svg", type: "image/svg+xml" },
    apple: { url: "/apple-icon.png", sizes: "180x180", type: "image/png" },
  });
  expect(manifest().icons).toContainEqual({
    src: "/icons/icon-512.png",
    sizes: "512x512",
    type: "image/png",
    purpose: "maskable",
  });
  for (const [file, size] of [
    ["app/apple-icon.png", 180],
    ["public/icons/icon-192.png", 192],
    ["public/icons/icon-512.png", 512],
  ] as const) {
    const png = readFileSync(new URL(`../${file}`, import.meta.url));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
  }
});
