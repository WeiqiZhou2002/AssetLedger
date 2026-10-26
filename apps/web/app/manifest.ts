import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Asset Ledger · 私人账簿",
    short_name: "私人账簿",
    lang: "zh-CN",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#f6f5f1",
    theme_color: "#213e35",
    icons: [
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
