"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { api, FormError, FormSheet, useLedgerMutation } from "@/components/ledger/forms";
import type { LinkSession } from "./link";
import { DuplicateChoices } from "./duplicate-choices";
const LinkLaunch = dynamic(() => import("./link").then((module) => module.LinkLaunch), { ssr: false });
export function BankConnectButton({ environment }: { environment: "sandbox" | "production" }) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<LinkSession | null>(null);
  const mutation = useLedgerMutation();
  const [existing, setExisting] = useState<{ id: string; institutionId: string | null }[]>([]);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const start = (allowDuplicate = false, connectionId?: string) =>
    mutation.run(async () => {
      const connections =
        await api<{ id: string; institutionId: string | null; status: string; environment: string }[]>(
          "/api/plaid/connections",
        );
      setExisting(connections.filter((row) => row.status !== "revoked" && row.environment === environment));
      const result = await api<{ link_token: string; expiration: string }>(
        connectionId ? `/api/plaid/connections/${connectionId}/link-token` : "/api/plaid/link-token",
        "POST",
        connectionId ? {} : { product: "transactions" },
      );
      const value = {
        token: result.link_token,
        expiration: result.expiration,
        ...(allowDuplicate ? { allowDuplicate: true } : {}),
        ...(connectionId ? { connectionId } : {}),
      };
      sessionStorage.setItem("asset-ledger:plaid-link:v1", JSON.stringify(value));
      setSession(value);
      setDuplicate(null);
      setOpen(false);
    });
  return (
    <>
      <Button onClick={() => setOpen(true)}>连接银行</Button>
      <FormSheet
        open={open}
        onOpenChange={setOpen}
        title="连接银行，自动导入流水"
        description="Plaid Link 使用英文界面。"
      >
        <p className="mb-5 text-sm leading-7">
          银行账户与交易资料将通过 Plaid。映射后默认自动入账，可逐连接切回人工审核。Trial 最多创建 10 个
          production Item，删除不返还名额。
        </p>
        <Button disabled={mutation.pending} onClick={() => void start()}>
          确认连接银行 / 信用卡
        </Button>
        <FormError error={mutation.error} />
      </FormSheet>
      {session ? (
        <LinkLaunch
          key={session.token}
          session={session}
          onDone={() => setSession(null)}
          existing={existing}
          onDuplicate={(id) => {
            setSession(null);
            setDuplicate(id);
          }}
        />
      ) : null}
      <FormSheet
        open={Boolean(duplicate)}
        onOpenChange={(value) => !value && setDuplicate(null)}
        title="这家机构已有连接"
        description="优先更新现有连接，避免占用新的 Trial 名额。"
      >
        <DuplicateChoices
          pending={mutation.pending}
          onReauthorize={() => duplicate && void start(false, duplicate)}
          onAdd={() => void start(true)}
        />
        <FormError error={mutation.error} />
      </FormSheet>
    </>
  );
}
