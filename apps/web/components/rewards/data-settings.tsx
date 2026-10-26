"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormError, SelectField, api, textField, useLedgerMutation } from "@/components/ledger/forms";
const confirmation = "删除全部个人数据";
export function DataSettings({ tables, totpEnabled }: { tables: string[]; totpEnabled: boolean }) {
  const router = useRouter();
  const [table, setTable] = useState("profile");
  const [phrase, setPhrase] = useState("");
  const mutation = useLedgerMutation();
  return (
    <div className="space-y-7">
      <section className="rounded-xl border bg-card p-5 sm:p-7">
        <h2 className="font-medium">导出个人数据</h2>
        <p className="mt-3 text-sm leading-7 text-muted-foreground">
          JSON 包含所有个人业务表与账户基本资料；CSV
          每次导出一张表。点数以完整整数字符串保存，不包含密码、两步验证密钥或登录会话。导出文件含个人财务记录，请妥善保存。
        </p>
        <div className="mt-5 flex flex-wrap items-end gap-3">
          <Button asChild>
            <a href="/api/export?format=json">下载完整 JSON</a>
          </Button>
          <SelectField label="CSV 数据表" value={table} onChange={(event) => setTable(event.target.value)}>
            {tables.map((name) => (
              <option value={name} key={name}>
                {name}
              </option>
            ))}
          </SelectField>
          <Button variant="outline" asChild>
            <a href={`/api/export?format=csv&table=${encodeURIComponent(table)}`}>下载 CSV</a>
          </Button>
        </div>
      </section>
      <section className="rounded-xl border bg-card p-5 sm:p-7">
        <h2 className="font-medium">加密备份与恢复</h2>
        <p className="mt-3 text-sm leading-7 text-muted-foreground">
          在部署主机按 README
          运行备份脚本，保存数据库与上传文件。恢复前先另做备份，并在独立环境演练。浏览器导出不包含原件文件。
        </p>
      </section>
      <section className="rounded-xl border border-destructive/30 bg-card p-5 sm:p-7">
        <h2 className="font-medium text-destructive">删除全部个人数据</h2>
        <p className="mt-3 text-sm leading-7 text-muted-foreground">
          将删除你的账户、流水、余额观察、账单、积分及上传文件，无法撤销。登录账号与安全设置保留；所有登录会话会失效。请先下载备份。
        </p>
        <form
          className="mt-5 max-w-lg space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            void mutation.run(async () => {
              await api("/api/settings/data", "DELETE", {
                confirmation: phrase,
                password: String(fields.get("password") ?? ""),
                ...(totpEnabled ? { totpCode: textField(fields, "totpCode") } : {}),
              });
              router.replace("/login");
            }, "个人数据已删除");
          }}
        >
          <Field
            label={`输入「${confirmation}」确认`}
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            autoComplete="off"
            required
          />
          <Field
            name="password"
            label="当前登录密码"
            type="password"
            autoComplete="current-password"
            required
          />
          {totpEnabled ? (
            <Field
              name="totpCode"
              label="两步验证码（不可重复使用）"
              inputMode="numeric"
              pattern="[0-9]{6}"
              autoComplete="one-time-code"
              required
            />
          ) : null}
          <FormError error={mutation.error} />
          <Button variant="destructive" disabled={phrase !== confirmation || mutation.pending}>
            {mutation.pending ? "正在删除…" : "永久删除个人数据并退出登录"}
          </Button>
        </form>
      </section>
    </div>
  );
}
