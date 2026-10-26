"use client";
import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { JsonSafe } from "@/lib/serialization";
import type { listConnections } from "@/lib/bank-sync/connections";
import { formatSyncTime } from "@/lib/bank-sync/time-format";
type FullConnection = JsonSafe<Awaited<ReturnType<typeof listConnections>>>[number];
type Connection = Pick<
  FullConnection,
  "id" | "status" | "errorCode" | "mappingConfirmedAt" | "institutionName" | "lastSuccessAt"
> & {
  accounts: Pick<
    FullConnection["accounts"][number],
    "isEnabled" | "accountId" | "type" | "securityAccountId"
  >[];
};
export function connectionNeedsAttention(connection: Connection) {
  return (
    connection.status !== "revoked" &&
    Boolean(
      connection.errorCode ||
      ["error", "login_required", "consent_expiring"].includes(connection.status) ||
      !connection.mappingConfirmedAt ||
      connection.accounts.some(
        (account) =>
          account.isEnabled &&
          (!account.accountId || (account.type === "investment" && !account.securityAccountId)),
      ),
    )
  );
}
export function ConnectionDisclosure({
  connection,
  timezone,
  pending,
  onSync,
  children,
}: {
  connection: Connection;
  timezone: string;
  pending: boolean;
  onSync: () => void;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(() => connectionNeedsAttention(connection));
  const status =
    connection.status === "revoked"
      ? "已删除"
      : ["login_required", "consent_expiring"].includes(connection.status)
        ? "需要重新授权"
        : connection.status === "error" || connection.errorCode
          ? "错误"
          : "正常";
  const mapped = connection.accounts.filter(
    (account) =>
      account.isEnabled && account.accountId && (account.type !== "investment" || account.securityAccountId),
  ).length;
  return (
    <section
      id={`connection-${connection.id}`}
      tabIndex={-1}
      className="min-w-0 scroll-mt-6 rounded-xl border bg-card p-4 target:border-primary sm:p-5"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`connection-details-${connection.id}`}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 basis-48 items-start gap-2 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ChevronDown
            aria-hidden
            className={`mt-1 size-4 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 font-medium break-words">{connection.institutionName}</span>
              <Badge variant="outline">{status}</Badge>
            </span>
            <span className="mt-1 block text-xs leading-6 text-muted-foreground">
              上次成功：
              {connection.lastSuccessAt
                ? formatSyncTime(connection.lastSuccessAt, timezone)
                : "尚未成功"} · {mapped} 个已映射账户
            </span>
          </span>
        </button>
        {connection.status !== "revoked" ? (
          <Button
            variant="outline"
            className="shrink-0"
            disabled={pending || !connection.mappingConfirmedAt}
            onClick={onSync}
          >
            立即同步
          </Button>
        ) : null}
      </div>
      <div
        id={`connection-details-${connection.id}`}
        hidden={!expanded}
        className="mt-4 min-w-0 space-y-4 border-t pt-4 break-words"
      >
        {children}
      </div>
    </section>
  );
}
