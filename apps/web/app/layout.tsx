import type { Metadata, Viewport } from "next";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: { default: "Asset Ledger · 私人账簿", template: "%s · Asset Ledger" },
  description: "你的资产、日常与每一笔变化。私人部署的个人财务账簿。",
  icons: {
    icon: { url: "/icon.svg", type: "image/svg+xml" },
    apple: { url: "/apple-icon.png", sizes: "180x180", type: "image/png" },
  },
  appleWebApp: { capable: true, statusBarStyle: "default", title: "私人账簿" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#213e35" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
