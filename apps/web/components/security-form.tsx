"use client";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
export function SecurityForm({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [setup, setSetup] = useState<{ qrCode: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function request(action: string, code?: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/auth/totp/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(code ? { code } : {}),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "操作失败，请重试");
        return;
      }
      if (action === "setup") setSetup(data);
      else if (action === "disable") {
        router.replace("/login");
        router.refresh();
      } else {
        setSetup(null);
        toast.success("两步验证已启用");
        router.refresh();
      }
    } catch {
      setError("暂时无法连接，请稍后重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="max-w-2xl rounded-2xl border bg-card p-6 sm:p-8">
      <div className="flex gap-3">
        <ShieldCheck className="mt-1 text-primary" size={24} />
        <div>
          <h2 className="text-lg font-medium">两步验证</h2>
          <p className="mt-2 text-sm leading-7 text-muted-foreground">
            {enabled
              ? "已启用。登录时需要密码和验证器中的验证码。"
              : "为登录再加一层保护。使用验证器生成的一次性验证码确认身份。"}
          </p>
        </div>
      </div>
      {!enabled && !setup ? (
        <Button className="mt-7" disabled={busy} onClick={() => request("setup")}>
          {busy ? "正在准备…" : "设置两步验证"}
        </Button>
      ) : null}
      {setup ? (
        <div className="mt-8 border-t pt-6">
          <h3 className="text-sm font-medium">用验证器扫描二维码</h3>
          <Image
            src={setup.qrCode}
            alt="两步验证设置二维码"
            width={240}
            height={240}
            unoptimized
            className="my-4 max-w-full rounded-lg border"
          />
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">无法扫码？手动输入密钥</summary>
            <code className="mt-3 block rounded-lg bg-muted p-4 break-all select-all">{setup.secret}</code>
          </details>
          <p className="mt-4 text-xs leading-6 text-muted-foreground">
            请妥善保存验证器备份。二维码 10 分钟内有效，完成下方验证后才会启用。
          </p>
        </div>
      ) : null}
      {enabled || setup ? (
        <form
          className="mt-7 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const code = String(new FormData(event.currentTarget).get("code"));
            void request(enabled ? "disable" : "enable", code);
          }}
        >
          <Label htmlFor="security-code">{enabled ? "输入当前验证码以关闭" : "输入 6 位验证码以确认"}</Label>
          <Input
            id="security-code"
            name="code"
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            minLength={6}
            required
            className="max-w-xs tracking-[0.3em]"
          />
          <Button type="submit" disabled={busy} variant={enabled ? "outline" : "default"}>
            {busy ? "正在验证…" : enabled ? "关闭两步验证" : "确认启用"}
          </Button>
          {enabled ? (
            <p className="text-xs leading-6 text-muted-foreground">
              关闭后会退出所有设备，需要重新登录。已使用的验证码不可重复使用，请等待下一组。
            </p>
          ) : null}
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
