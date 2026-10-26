"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConnectionDisclosure } from "./connection-disclosure";
import { FormError, FormSheet, api, useLedgerMutation } from "@/components/ledger/forms";
import type { Account } from "@/components/ledger/types";
import type { JsonSafe } from "@/lib/serialization";
import type { listConnections } from "@/lib/bank-sync/connections";
import { BackfillForm, SyncRunSummary } from "./backfill-form";
import { formatSyncTime } from "@/lib/bank-sync/time-format";
import { MappingForm } from "./mapping-form";
import type { LinkSession } from "./link";
import { ResetForm } from "./reset-form";
const LinkLaunch = dynamic(() => import("./link").then((module) => module.LinkLaunch), { ssr: false });
const storageKey = "asset-ledger:plaid-link:v1";
type Connections = JsonSafe<Awaited<ReturnType<typeof listConnections>>>;
export function ConnectionsView({
  connections,
  accounts,
  environment,
  interval,
  timezone,
}: {
  connections: Connections;
  accounts: Account[];
  environment: "sandbox" | "production";
  interval: number;
  timezone: string;
}) {
  const mutation = useLedgerMutation();
  const router = useRouter();
  const [session, setSession] = useState<LinkSession | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [newProduct, setNewProduct] = useState<"transactions" | "investments" | null>(null);
  const current = connections.filter((row) => row.environment === environment);
  const resetNames = Object.fromEntries([
    ...current.map((row) => [row.id, row.institutionName]),
    ...accounts.map((row) => [row.id, row.name]),
  ]);
  const waitingForSync = current.some(
    (row) =>
      ["active", "consent_expiring"].includes(row.status) &&
      row.mappingConfirmedAt &&
      (row.backfillPending ||
        !row.lastSuccessAt ||
        row.mappingConfirmedAt > row.lastSuccessAt ||
        (row.lastRequestedAt && row.lastRequestedAt > row.lastSuccessAt)),
  );
  useEffect(() => {
    if (!waitingForSync) return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [waitingForSync, router]);
  const start = (product: "transactions" | "investments", id?: string) =>
    mutation.run(async () => {
      const result = await api<{ link_token: string; expiration: string }>(
        id ? `/api/plaid/connections/${id}/link-token` : "/api/plaid/link-token",
        "POST",
        id ? {} : { product },
      );
      const value = {
        token: result.link_token,
        expiration: result.expiration,
        ...(id ? { connectionId: id } : {}),
      };
      sessionStorage.setItem(storageKey, JSON.stringify(value));
      setNewProduct(null);
      setDuplicate(null);
      setSession(value);
    });
  return (
    <div className="space-y-6">
      <div id="connect-banks" className="scroll-mt-6 rounded-xl border bg-card p-5 text-sm leading-7">
        <Badge>{environment === "sandbox" ? "Sandbox · 测试数据" : "Production · Trial"}</Badge>
        <p className="mt-3">
          银行账户与交易资料会通过
          Plaid。默认自动入账，转账与重复候选集中在待处理；可逐连接切回审核。余额仅生成机构观察。每 {interval}{" "}
          小时同步一次。
        </p>
        {environment === "production" ? (
          <p className="mt-2 font-medium">
            已创建 {current.length} / 10 个连接（删除不返还名额）。此计数仅覆盖本地保留记录，最终额度以 Plaid
            为准。
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-3">
          <Button disabled={mutation.pending} onClick={() => setNewProduct("transactions")}>
            连接银行 / 信用卡
          </Button>
          <Button variant="outline" disabled={mutation.pending} onClick={() => setNewProduct("investments")}>
            连接投资账户
          </Button>
          {current.some((row) => row.status === "active") ? (
            <ResetForm connectionIds="all" names={resetNames} label="重置全部连接" />
          ) : null}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Fidelity 可使用通用 CSV 映射导入流水，市值通过账户详情更新。各机构与产品是否可连接，以 Link
          的实时支持情况为准。
        </p>
      </div>
      <FormError error={mutation.error} />
      {session ? (
        <LinkLaunch
          key={session.token}
          session={session}
          onDone={() => setSession(null)}
          existing={current.filter((row) => row.status !== "revoked")}
          onDuplicate={(id) => {
            setSession(null);
            setDuplicate(id);
          }}
        />
      ) : null}
      {current.length ? (
        current.map((connection) => (
          <ConnectionDisclosure
            key={connection.id}
            connection={connection}
            timezone={timezone}
            pending={mutation.pending}
            onSync={() =>
              void mutation.run(async () => {
                await api(`/api/plaid/connections/${connection.id}/sync`, "POST");
              }, "已排队，请稍后查看收件箱")
            }
          >
            <p className="text-xs leading-6 text-muted-foreground">
              上次尝试：
              {connection.lastSyncedAt ? formatSyncTime(connection.lastSyncedAt, timezone) : "尚未同步"}
              <br />
              上次成功：
              {connection.lastSuccessAt ? formatSyncTime(connection.lastSuccessAt, timezone) : "尚未成功"}
              {connection.errorCode
                ? ` · ${connection.errorCode.startsWith("MISSING_FX_") ? "缺少 " + connection.errorCode.slice(11).replaceAll("_", "、") + " 汇率" : connection.errorCode}`
                : ""}
              {connection.consentExpiresAt ? ` · 授权到期 ${connection.consentExpiresAt.slice(0, 10)}` : ""}
            </p>
            <p className="text-xs leading-6 text-muted-foreground">
              {connection.products.includes("transactions") ? (
                <>
                  Plaid 可提供的历史起点 ≈ {connection.availabilityStart}（初始化请求{" "}
                  {connection.daysRequested} 天）。 补导和重置不能扩大此范围；更早流水可上传
                  PDF/CSV。重新连接会消耗 Trial 名额。
                </>
              ) : (
                "此连接不提供交易流水，仅同步余额/持仓"
              )}
            </p>
            {connection.latestRun ? <SyncRunSummary run={connection.latestRun} timezone={timezone} /> : null}
            {connection.backfillPending && connection.latestRun?.status !== "failed" ? (
              <p className="text-sm text-muted-foreground">
                等待银行历史同步及账单审核完成；期初未被编辑且无待审核行时重算。若仍有待审核行，请先审核，再点立即同步。
              </p>
            ) : null}
            {["login_required", "consent_expiring"].includes(connection.status) ? (
              <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
                银行需要更新授权，请点击“重新授权”。现有账本记录保持可用。
              </p>
            ) : null}
            {connection.status !== "revoked" ? (
              <>
                <label className="flex items-start gap-3 rounded-lg bg-muted/50 p-3 text-sm leading-6">
                  <input
                    type="checkbox"
                    checked={connection.autoPost}
                    disabled={mutation.pending}
                    className="mt-1 size-4 shrink-0"
                    onChange={(event) => {
                      const autoPost = event.target.checked;
                      void mutation.run(
                        async () => {
                          await api(`/api/plaid/connections/${connection.id}/auto-post`, "POST", {
                            autoPost,
                          });
                        },
                        autoPost ? "已开启，下次同步处理未决交易" : "已切回逐行审核",
                      );
                    }}
                  />
                  <span>
                    自动入账
                    <span className="block text-xs text-muted-foreground">
                      关闭后，新流水先进入审核收件箱；已入账流水不变。
                    </span>
                  </span>
                </label>
                <MappingForm
                  key={`${connection.id}:${connection.updatedAt}`}
                  connection={connection}
                  accounts={accounts}
                />
                <div className="flex flex-wrap gap-2">
                  {connection.status === "active" ? (
                    <ResetForm connectionIds={[connection.id]} names={resetNames} />
                  ) : null}
                  {connection.status === "active" && connection.mappingConfirmedAt ? (
                    <BackfillForm connectionId={connection.id} fromDate={connection.defaultBackfillFrom} />
                  ) : null}
                  {connection.products.includes("transactions") ? (
                    <Button
                      variant="outline"
                      disabled={mutation.pending || !connection.mappingConfirmedAt}
                      onClick={() =>
                        void mutation.run(async () => {
                          await api(`/api/plaid/connections/${connection.id}/refresh`, "POST");
                        }, "已请求银行刷新并排队同步")
                      }
                    >
                      请求银行刷新
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    disabled={mutation.pending}
                    onClick={() => void start("transactions", connection.id)}
                  >
                    重新授权
                  </Button>
                  <Button variant="ghost" onClick={() => setRemoving(connection.id)}>
                    删除
                  </Button>
                  <Button variant="link" asChild>
                    <Link href="/statements?tab=inbox">查看审核收件箱 →</Link>
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">连接已撤销，原有流水和观察保留。</p>
            )}
          </ConnectionDisclosure>
        ))
      ) : (
        <p className="rounded-xl border border-dashed p-6 text-sm">
          还没有银行连接。连接后先确认账户映射与导入起始日。
        </p>
      )}
      <FormSheet
        open={Boolean(newProduct)}
        onOpenChange={(open) => !open && setNewProduct(null)}
        title="连接前确认"
        description="Plaid Link 使用英文界面。"
      >
        <p className="mb-4 text-sm leading-7">
          若这家机构已连接，请返回并选择“重新授权”，避免创建重复 Item。Trial 最多创建 10 个 production
          Item，删除不会返还名额。账户与交易数据将通过 Plaid。
        </p>
        <Button disabled={mutation.pending} onClick={() => newProduct && void start(newProduct)}>
          确认连接新机构
        </Button>
        <FormError error={mutation.error} />
      </FormSheet>
      <FormSheet
        open={Boolean(duplicate)}
        onOpenChange={(open) => !open && setDuplicate(null)}
        title="这家机构已有连接"
        description="优先更新现有连接，避免占用新的 Trial 名额。"
      >
        <Button
          disabled={mutation.pending}
          onClick={() => duplicate && void start("transactions", duplicate)}
        >
          更新现有授权
        </Button>
        <FormError error={mutation.error} />
      </FormSheet>
      <FormSheet
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="删除银行连接"
        description="撤销 Plaid Item；已入账流水和观察仍保留。Trial 名额不会返还。"
      >
        <Button
          variant="destructive"
          disabled={mutation.pending}
          onClick={() =>
            void mutation.run(async () => {
              await api(`/api/plaid/connections/${removing}`, "DELETE");
              setRemoving(null);
            })
          }
        >
          确认撤销连接
        </Button>
        <FormError error={mutation.error} />
      </FormSheet>
    </div>
  );
}
