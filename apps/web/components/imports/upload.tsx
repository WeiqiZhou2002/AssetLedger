"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FormError, FormSheet, SelectField, useLedgerMutation } from "@/components/ledger/forms";
import type { Account } from "@/components/ledger/types";
export function StatementUpload({
  accounts,
  maxMb,
  secondary = false,
}: {
  accounts: Account[];
  maxMb: number;
  secondary?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const mutation = useLedgerMutation();
  const router = useRouter();
  return (
    <>
      <Button
        variant={secondary ? "outline" : "default"}
        className="h-auto min-h-10 whitespace-normal"
        onClick={() => setOpen(true)}
      >
        <Upload size={16} />
        上传 PDF / CSV
      </Button>
      <FormSheet
        open={open}
        onOpenChange={setOpen}
        title="上传账单"
        description={`PDF 或 UTF-8 CSV，最多 ${maxMb} MB。密码仅用于本次解锁。`}
      >
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            const body = new FormData(event.currentTarget);
            void mutation.run(async () => {
              const response = await fetch("/api/statements", { method: "POST", body });
              const result = await response.json();
              if (!response.ok) throw new Error(result.error ?? "上传失败");
              setOpen(false);
              router.push(`/statements/${result.id}`);
            }, "文件已接收");
          }}
        >
          <Field
            name="file"
            label="原始账单"
            type="file"
            accept=".pdf,.csv,application/pdf,text/csv"
            required
          />
          <SelectField name="accountId" label="所属账户（可稍后匹配）" defaultValue="">
            <option value="">按尾号识别 / 稍后选择</option>
            {accounts
              .filter((account) => account.isActive)
              .map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} · {account.currency}
                </option>
              ))}
          </SelectField>
          <Field name="password" label="PDF 密码（如有）" type="password" autoComplete="off" />
          <FormError error={mutation.error} />
          <Button type="submit" disabled={mutation.pending} className="w-full">
            {mutation.pending ? "正在上传…" : "上传并识别"}
          </Button>
        </form>
      </FormSheet>
    </>
  );
}
