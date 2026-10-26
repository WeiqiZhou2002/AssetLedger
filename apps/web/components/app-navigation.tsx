"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  ArrowLeftRight,
  ChartNoAxesCombined,
  CreditCard,
  FileUp,
  Gift,
  House,
  Menu,
  Settings,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetDescription,
} from "@/components/ui/sheet";
import { BrandLogo } from "@/components/brand-logo";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
const items = [
  { href: "/dashboard", label: "总览", icon: House },
  { href: "/activity", label: "流水", icon: ArrowLeftRight },
  { href: "/statements", label: "导入与同步", icon: FileUp },
  { href: "/accounts", label: "账户", icon: CreditCard },
  { href: "/benefits", label: "卡权益", icon: Gift },
  { href: "/investments", label: "投资", icon: ChartNoAxesCombined },
  { href: "/rewards", label: "积分里程", icon: Gift },
  { href: "/settings", label: "设置", icon: Settings },
];
function Brand() {
  return (
    <Link href="/dashboard" className="flex items-center gap-3">
      <BrandLogo />
      <span>
        <span className="block font-semibold tracking-tight">Asset Ledger</span>
        <span className="text-[10px] tracking-[0.22em] text-muted-foreground">我的私人账簿</span>
      </span>
    </Link>
  );
}
export function AppNavigation({ pendingCount = 0 }: { plaidEnabled?: boolean; pendingCount?: number }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const navigation = items;
  const active = (href: string) => pathname.startsWith(href);
  const badge = (href: string) =>
    href === "/statements" && pendingCount > 0 ? (
      <span
        aria-label={`${pendingCount} 项待处理`}
        className="rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground"
      >
        {pendingCount}
      </span>
    ) : null;
  const nav = (
    <nav aria-label="主导航" className="space-y-1">
      {navigation.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          onClick={() => setOpen(false)}
          aria-current={active(href) ? "page" : undefined}
          className={cn(
            "flex items-center gap-3 rounded-lg px-3 py-3 text-sm transition-colors hover:bg-muted",
            active(href) ? "bg-primary/8 font-medium text-primary" : "text-muted-foreground",
          )}
        >
          <Icon size={18} strokeWidth={1.6} />
          {label}
          {badge(href)}
        </Link>
      ))}
    </nav>
  );
  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col overflow-y-auto border-r bg-card px-6 py-8 lg:flex">
        <Brand />
        <p className="eyebrow mt-12 mb-4 px-3">账簿</p>
        {nav}
        <div className="mt-auto border-t pt-5 text-xs leading-6 text-muted-foreground">
          每一笔，都有迹可循。
          <br />
          <span className="inline-block size-1.5 rounded-full bg-primary" /> 私人部署 · 数据由你保管
        </div>
      </aside>
      <header className="flex items-center justify-between border-b bg-card px-5 py-4 lg:hidden">
        <Brand />
        <span className="text-xs text-muted-foreground">私人账簿</span>
      </header>
      <nav
        aria-label="移动导航"
        className="fixed inset-x-0 bottom-0 z-40 flex justify-around border-t bg-card/95 px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur lg:hidden"
      >
        {navigation.slice(0, 3).map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            aria-current={active(href) ? "page" : undefined}
            className={cn(
              "flex min-w-14 flex-col items-center gap-1 rounded-lg px-2 py-2 text-[11px]",
              active(href) ? "bg-primary/8 text-primary" : "text-muted-foreground",
            )}
          >
            <span className="relative">
              <Icon size={20} />
              <span className="absolute -top-2 -right-4">{badge(href)}</span>
            </span>
            {label}
          </Link>
        ))}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" className="h-auto min-w-16 flex-col gap-1 py-2 text-[11px]">
              <Menu size={20} />
              更多
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-72 px-5">
            <SheetHeader className="px-0">
              <SheetTitle>我的账簿</SheetTitle>
              <SheetDescription>资产、日常与每一笔变化</SheetDescription>
            </SheetHeader>
            {nav}
          </SheetContent>
        </Sheet>
      </nav>
    </>
  );
}
