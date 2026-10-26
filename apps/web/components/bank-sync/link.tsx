"use client";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { usePlaidLink } from "react-plaid-link";
import { toast } from "sonner";
import { api } from "@/components/ledger/forms";
import { Button } from "@/components/ui/button";
export const LINK_STORAGE = "asset-ledger:plaid-link:v1";
export type LinkSession = {
  token: string;
  connectionId?: string;
  expiration: string;
  allowDuplicate?: boolean;
};
export function LinkLaunch({
  session,
  oauth = false,
  onDone,
  existing = [],
  onDuplicate,
}: {
  session: LinkSession;
  oauth?: boolean;
  onDone: (connectionId?: string) => void;
  existing?: { id: string; institutionId: string | null }[];
  onDuplicate?: (id: string) => void;
}) {
  const router = useRouter();
  const opened = useRef(false);
  const { open, ready, error, exit } = usePlaidLink({
    token: session.token,
    ...(oauth ? { receivedRedirectUri: window.location.href } : {}),
    onSuccess: (publicToken, metadata) => {
      void (async () => {
        try {
          let connectionId = session.connectionId;
          if (session.connectionId)
            await api(`/api/plaid/connections/${session.connectionId}/reauth`, "POST");
          else {
            const result = await api<{ connection: { id: string } }>("/api/plaid/exchange", "POST", {
              public_token: publicToken,
              institution: metadata.institution ?? { institution_id: null, name: "Plaid institution" },
              ...(session.allowDuplicate ? { allowDuplicate: true } : {}),
            });
            connectionId = result.connection.id;
          }
          sessionStorage.removeItem(LINK_STORAGE);
          toast.success(session.connectionId ? "授权已更新" : "连接已保存，请确认账户映射");
          router.push(`/statements?tab=sync&connection=${connectionId}#connection-${connectionId}`);
          router.refresh();
          onDone(connectionId);
        } catch (error) {
          sessionStorage.removeItem(LINK_STORAGE);
          toast.error(error instanceof Error ? error.message : "连接未完成，请到银行连接检查");
          router.refresh();
          onDone();
        }
      })();
    },
    onExit: (error) => {
      if (error) toast.error("Plaid Link 未完成，请重试或检查银行授权状态");
      sessionStorage.removeItem(LINK_STORAGE);
      onDone();
    },
    onEvent: (event, metadata) => {
      if (session.connectionId || session.allowDuplicate || event !== "SELECT_INSTITUTION") return;
      const duplicate = existing.find((row) => row.institutionId === metadata.institution_id);
      if (duplicate) {
        exit({ force: true });
        onDuplicate?.(duplicate.id);
      }
    },
  });
  useEffect(() => {
    if (ready && !opened.current) {
      opened.current = true;
      open();
    }
  }, [ready, open]);
  useEffect(() => {
    if (error) toast.error("Plaid Link 脚本加载失败，请检查 CSP 或网络");
  }, [error]);
  return (
    <p className="text-sm text-muted-foreground">
      {error ? "连接窗口加载失败。" : "正在打开 Plaid 的英文授权窗口…"}
    </p>
  );
}
const subscribe = () => () => {};
const stored = () => {
  const raw = sessionStorage.getItem(LINK_STORAGE);
  try {
    const session = raw ? (JSON.parse(raw) as LinkSession) : null;
    return session && Date.parse(session.expiration) > Date.now() ? raw : null;
  } catch {
    return null;
  }
};
export function OAuthReturn() {
  const raw = useSyncExternalStore(subscribe, stored, () => null);
  const router = useRouter();
  let session: LinkSession | null = null;
  try {
    session = raw ? (JSON.parse(raw) as LinkSession) : null;
  } catch {
    /* Show recovery path. */
  }
  return (
    <div className="space-y-5 rounded-xl border bg-card p-6">
      <h1 className="text-xl">返回银行授权</h1>
      {session?.token ? (
        <LinkLaunch
          session={session}
          oauth
          onDone={(id) => {
            if (!id) router.replace("/statements?tab=sync");
          }}
        />
      ) : (
        <p className="text-sm">本次授权记录已过期或不在此浏览器中，请返回银行连接重试。</p>
      )}
      <Button variant="outline" onClick={() => router.replace("/statements?tab=sync")}>
        返回银行连接
      </Button>
    </div>
  );
}
