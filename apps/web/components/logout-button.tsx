"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error();
      router.replace("/login");
      router.refresh();
    } catch {
      toast.error("退出失败，请重试");
      setBusy(false);
    }
  }
  return (
    <Button onClick={logout} disabled={busy} variant="ghost" size="sm">
      <LogOut size={15} />
      {busy ? "正在退出" : "退出登录"}
    </Button>
  );
}
