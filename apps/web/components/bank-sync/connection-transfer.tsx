"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FormError, useLedgerMutation } from "@/components/ledger/forms";
import type { ConnectionImportResult } from "@/lib/bank-sync/connection-import";
export function ConnectionTransfer({ totpEnabled }: { totpEnabled: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="min-w-0 rounded-xl border bg-card p-4 sm:p-5">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="connection-transfer-details"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 rounded-md text-left font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ChevronDown
          aria-hidden
          className={`size-4 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
        迁移银行连接
      </button>
      <div id="connection-transfer-details" hidden={!expanded}>
        {expanded ? <TransferForm totpEnabled={totpEnabled} /> : null}
      </div>
    </section>
  );
}
export function TransferForm({ totpEnabled }: { totpEnabled: boolean }) {
  const [mode, setMode] = useState<"export" | "import">("export");
  const [results, setResults] = useState<ConnectionImportResult[] | null>(null);
  const mutation = useLedgerMutation();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setResults(null);
    void mutation.run(
      async () => {
        try {
          if (mode === "import") {
            const file = data.get("file");
            if (!(file instanceof File) || !file.size) throw new Error("请选择连接文件");
            if (file.size > 256 * 1024) throw new Error("连接文件不能超过 256 KB");
          }
          const response = await fetch(`/api/plaid/connections/${mode}`, {
            method: "POST",
            cache: "no-store",
            ...(mode === "export"
              ? {
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(Object.fromEntries(data)),
                }
              : { body: data }),
          });
          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error ?? "迁移操作失败，请重试");
          }
          if (mode === "import") {
            const result = (await response.json()) as { results: ConnectionImportResult[] };
            setResults(result.results);
          } else {
            const url = URL.createObjectURL(await response.blob());
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download =
              response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ??
              "asset-ledger-plaid-connections.json";
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);
          }
        } finally {
          form.reset();
          data.delete("password");
          data.delete("code");
          data.delete("passphrase");
          data.delete("file");
        }
      },
      mode === "export" ? "已下载加密连接文件" : "连接文件已处理，请查看结果",
    );
  };
  return (
    <div className="mt-4 space-y-4 border-t pt-4 text-sm leading-7">
      <p>将已有连接迁入使用相同 Plaid 环境和开发者凭据的新实例，无需重新连接银行或创建新的 Item。</p>
      <p className="font-medium">
        文件加口令后仍等同银行数据访问钥匙；导入后请删除文件；不要在旧实例点「删除连接」（会撤销 Plaid
        Item，新实例也会失效）。
      </p>
      <p className="text-muted-foreground">
        迁移后请停用旧实例的 Plaid 同步。个人数据导出仍不含银行访问令牌。
      </p>
      <div className="flex gap-3">
        <Button
          type="button"
          disabled={mutation.pending}
          variant={mode === "export" ? "secondary" : "outline"}
          onClick={() => setMode("export")}
        >
          导出连接
        </Button>
        <Button
          type="button"
          disabled={mutation.pending}
          variant={mode === "import" ? "secondary" : "outline"}
          onClick={() => setMode("import")}
        >
          导入连接
        </Button>
      </div>
      <form key={mode} onSubmit={submit} className="max-w-xl space-y-4">
        {mode === "import" ? (
          <Field
            label="连接文件（JSON，最大 256 KB）"
            type="file"
            name="file"
            accept="application/json,.json"
            required
            disabled={mutation.pending}
          />
        ) : (
          <p className="text-muted-foreground">
            导出当前环境中全部未撤销的连接，不包含流水、余额或账本账户映射。
          </p>
        )}
        <Field
          label={mode === "export" ? "迁移口令（12–1024 个字符，须不同于登录密码）" : "迁移口令"}
          type="password"
          name="passphrase"
          autoComplete="new-password"
          minLength={12}
          maxLength={1024}
          required
          disabled={mutation.pending}
        />
        {totpEnabled ? (
          <Field
            label="新的两步验证码"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            disabled={mutation.pending}
          />
        ) : (
          <Field
            label="当前登录密码"
            name="password"
            type="password"
            autoComplete="current-password"
            maxLength={1024}
            required
            disabled={mutation.pending}
          />
        )}
        <Button type="submit" disabled={mutation.pending}>
          {mutation.pending ? "正在处理…" : mode === "export" ? "验证并下载连接文件" : "验证并导入连接"}
        </Button>
        <FormError error={mutation.error} />
      </form>
      {results ? (
        <div role="status" className="space-y-2">
          <ul>
            {results.map((row, index) => (
              <li key={index}>
                {row.institutionName}：
                {row.status === "imported"
                  ? "已导入"
                  : row.status === "existing"
                    ? "已存在"
                    : `失败（${row.reason}）`}
              </li>
            ))}
          </ul>
          <Link href="/statements?tab=sync#connect-banks" className="text-primary underline">
            前往导入与同步，确认账户映射
          </Link>
        </div>
      ) : null}
    </div>
  );
}
