"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, FormError, useLedgerMutation } from "@/components/ledger/forms";
import type { LoyaltyAccountDeleteCounts } from "@/lib/rewards/delete";

export function DeleteRewardAccount({ accountId, onDeleted }: { accountId: string; onDeleted: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const mutation = useLedgerMutation();
  async function remove() {
    setLoading(true);
    setError("");
    try {
      const counts = await api<LoyaltyAccountDeleteCounts>(
        `/api/loyalty/accounts/${accountId}/delete-preview`,
      );
      if (
        !window.confirm(
          `删除此积分账户？将同时删除 ${counts.events} 条积分事件、${counts.observations} 条余额观察和 ${counts.transfers} 笔转点。` +
            `\n转点会整笔删除，包含对方账户的 ${counts.otherAccountEvents} 条事件，对方余额将重新计算。此操作无法撤销。`,
        )
      )
        return;
      await mutation.run(async () => {
        await api(`/api/loyalty/accounts/${accountId}`, "DELETE", counts);
        onDeleted();
      }, "积分账户已删除");
    } catch (error) {
      setError(error instanceof Error ? error.message : "无法加载删除预览，请重试");
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="space-y-3 border-t pt-5">
      <Button
        variant="destructive"
        size="sm"
        disabled={loading || mutation.pending}
        onClick={() => void remove()}
      >
        {loading ? "处理中…" : "删除"}
      </Button>
      <FormError error={error || mutation.error} />
    </div>
  );
}
