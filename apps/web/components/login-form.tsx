"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
export function LoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<"password" | "totp">("password");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const response = await fetch(`/api/auth/${step === "password" ? "login" : "totp"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(data)),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error ?? "登录失败，请重试");
        return;
      }
      if (result.totpRequired) {
        form.reset();
        setStep("totp");
      } else {
        router.replace("/dashboard");
        router.refresh();
      }
    } catch {
      setError("暂时无法连接，请稍后重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="mt-8 space-y-5">
      {step === "password" ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="email">邮箱</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              maxLength={254}
              placeholder="you@example.com"
              required
              className="h-12"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              maxLength={1024}
              required
              className="h-12"
            />
          </div>
        </>
      ) : (
        <div className="space-y-3">
          <Label htmlFor="code">两步验证码</Label>
          <p className="text-sm leading-6 text-muted-foreground">打开你的验证器，输入当前的 6 位验证码。</p>
          <Input
            id="code"
            name="code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            autoComplete="one-time-code"
            maxLength={6}
            minLength={6}
            required
            autoFocus
            className="h-12 text-lg tracking-[0.4em]"
          />
        </div>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button disabled={busy} className="h-12 w-full" type="submit">
        {busy ? "正在验证…" : step === "password" ? "进入账簿" : "验证并登录"}
        <ArrowRight size={17} />
      </Button>
      {step === "totp" ? (
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          onClick={() => {
            setStep("password");
            setError("");
          }}
        >
          返回密码登录
        </Button>
      ) : null}
      <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <LockKeyhole size={13} />
        仅限账簿所有者访问
      </p>
    </form>
  );
}
