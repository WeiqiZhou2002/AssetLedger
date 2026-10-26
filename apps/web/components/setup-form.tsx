"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
export function SetupForm({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    // Keep the one-time token out of subsequent navigation and browser history.
    window.history.replaceState(window.history.state, "", "/setup");
  }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    if (values.password !== values.confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, token }),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error ?? "设置失败，请重试");
        return;
      }
      form.reset();
      router.replace("/setup/next");
      router.refresh();
    } catch {
      setError("暂时无法连接，请稍后重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="mt-8 space-y-5">
      <div className="space-y-2">
        <Label htmlFor="email">邮箱</Label>
        <Input
          id="email"
          name="email"
          type="email"
          maxLength={254}
          required
          autoComplete="username"
          className="h-12"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">密码（12–1024 个字符）</Label>
        <Input
          id="password"
          name="password"
          type="password"
          minLength={12}
          maxLength={1024}
          required
          autoComplete="new-password"
          className="h-12"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm-password">确认密码</Label>
        <Input
          id="confirm-password"
          name="confirmPassword"
          type="password"
          minLength={12}
          maxLength={1024}
          required
          autoComplete="new-password"
          className="h-12"
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy} className="h-12 w-full">
        {busy ? "正在创建…" : "创建管理员并登录"}
      </Button>
    </form>
  );
}
