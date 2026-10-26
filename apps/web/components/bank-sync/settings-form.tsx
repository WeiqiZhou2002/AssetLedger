"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PublicPlaidSettings } from "@/lib/bank-sync/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function PlaidSettingsForm({
  initial,
  environments,
  callbackUrl,
}: {
  initial: PublicPlaidSettings;
  environments: { environment: "sandbox" | "production"; count: number }[];
  callbackUrl: string;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [environment, setEnvironment] = useState(initial.environment);
  const [clientId, setClientId] = useState(initial.clientId);
  const [secret, setSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState(initial.redirectUri ?? "");
  const [enabled, setEnabled] = useState(initial.enabled);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const others = environments
    .filter((row) => row.environment !== environment)
    .reduce((sum, row) => sum + row.count, 0);
  const needsConfirmation = environment !== saved.environment && others > 0;
  async function submit(test: boolean) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/plaid/settings${test ? "/test" : ""}`, {
        method: test ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          environment,
          clientId,
          secret,
          redirectUri,
          enabled,
          confirmEnvironmentChange: confirmed,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error ?? "保存失败，请重试");
        return;
      }
      setSaved(result);
      setSecret("");
      setConfirmed(false);
      setMessage(test ? "凭据测试成功，已保存" : "已保存");
      router.refresh();
    } catch {
      setError("暂时无法连接，请稍后重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="max-w-2xl rounded-xl border bg-card p-5 sm:p-7">
      <h2 className="text-lg font-semibold">Plaid 凭据</h2>
      {saved.source === "env" ? (
        <div className="mt-4 space-y-2 text-sm">
          <p>由服务器环境变量管理</p>
          <p className="text-muted-foreground">
            环境：{saved.environment === "sandbox" ? "Sandbox" : "Production"} ·{" "}
            {saved.enabled ? "已启用" : "未启用"}
          </p>
        </div>
      ) : (
        <form
          className="mt-5 space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(false);
          }}
        >
          <fieldset disabled={busy} className="space-y-5 disabled:opacity-60">
            <div className="space-y-2">
              <Label htmlFor="plaid-environment">环境</Label>
              <select
                id="plaid-environment"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={environment}
                onChange={(event) => {
                  setEnvironment(event.target.value as typeof environment);
                  setConfirmed(false);
                }}
              >
                <option value="sandbox">Sandbox</option>
                <option value="production">Production</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="plaid-client">Client ID</Label>
              <Input
                id="plaid-client"
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                required
                maxLength={256}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="plaid-secret">Secret {saved.hasSecret ? "· 已保存" : ""}</Label>
              <Input
                id="plaid-secret"
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                maxLength={1024}
                autoComplete="new-password"
                placeholder={saved.hasSecret ? "留空保留已保存的 Secret" : "填写 Secret"}
                required={!saved.hasSecret}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="plaid-redirect">OAuth 回跳地址（可选）</Label>
              <Input
                id="plaid-redirect"
                type="url"
                value={redirectUri}
                onChange={(event) => setRedirectUri(event.target.value)}
                maxLength={2048}
                placeholder={callbackUrl}
              />
              <p className="text-xs leading-6 break-all text-muted-foreground">
                请在 Plaid Dashboard 注册 {callbackUrl}，并在此填写相同地址。Production 需要 HTTPS。
              </p>
            </div>
            <Label className="flex items-center gap-3">
              <input
                type="checkbox"
                role="switch"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
                className="size-4 accent-primary"
              />
              启用
            </Label>
            {needsConfirmation ? (
              <div className="space-y-3 rounded-lg border p-4 text-sm leading-6" role="alert">
                <p>
                  另一环境有 {others} 个连接。切换后它们将停止同步，直到切回原环境；授权令牌不能跨环境使用。
                </p>
                <Label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                    className="size-4 accent-primary"
                  />
                  确认切换环境
                </Label>
              </div>
            ) : null}
            <p className="text-xs leading-6 text-muted-foreground">
              启用前须成功测试凭据。「测试凭据」成功后会保存当前表单；修改环境、Client ID 或 Secret
              后须重新测试。{saved.verifiedAt ? `上次验证：${saved.verifiedAt.slice(0, 10)}` : ""}
            </p>
            <div className="flex flex-wrap gap-3">
              <Button type="submit" disabled={needsConfirmation && !confirmed}>
                保存
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={needsConfirmation && !confirmed}
                onClick={() => void submit(true)}
              >
                测试凭据
              </Button>
            </div>
          </fieldset>
          {busy ? (
            <p role="status" className="text-sm text-muted-foreground">
              正在处理…
            </p>
          ) : null}
          {message ? (
            <p role="status" className="text-sm text-primary">
              {message}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </form>
      )}
    </section>
  );
}
