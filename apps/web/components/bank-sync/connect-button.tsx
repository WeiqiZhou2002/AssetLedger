"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, FormError, FormSheet, useLedgerMutation } from "@/components/ledger/forms";
import type { LinkSession } from "./link";
const LinkLaunch = dynamic(() => import("./link").then((module) => module.LinkLaunch), { ssr: false });
export function BankConnectButton() {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<LinkSession | null>(null);
  const mutation = useLedgerMutation();
  const router = useRouter();
  const [existing, setExisting] = useState<{ id: string; institutionId: string | null }[]>([]);
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
        <Button
          disabled={mutation.pending}
          onClick={() =>
            void mutation.run(async () => {
              const connections =
                await api<{ id: string; institutionId: string | null; status: string }[]>(
                  "/api/plaid/connections",
                );
              setExisting(connections.filter((row) => row.status !== "revoked"));
              const result = await api<{ link_token: string; expiration: string }>(
                "/api/plaid/link-token",
                "POST",
                { product: "transactions" },
              );
              const value = { token: result.link_token, expiration: result.expiration };
              sessionStorage.setItem("asset-ledger:plaid-link:v1", JSON.stringify(value));
              setSession(value);
              setOpen(false);
            })
          }
        >
          确认连接银行 / 信用卡
        </Button>
        <FormError error={mutation.error} />
      </FormSheet>
      {session ? (
        <LinkLaunch
          session={session}
          onDone={() => setSession(null)}
          existing={existing}
          onDuplicate={(id) => {
            setSession(null);
            toast.info("这家机构已有连接，请重新授权现有连接");
            router.push(`/statements?tab=sync#connection-${id}`);
          }}
        />
      ) : null}
    </>
  );
}
