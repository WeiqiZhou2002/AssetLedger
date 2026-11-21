"use client";
import { api, FormError, useLedgerMutation } from "@/components/ledger/forms";
import type { EntryCreditMatch } from "@/lib/benefits/credit-match";

export function BenefitAssignmentSelect({
  entryId,
  productId,
  credits,
  assignment,
}: {
  entryId: string;
  productId: string;
  credits: { id: string; name: string }[];
  assignment?: EntryCreditMatch;
}) {
  const mutation = useLedgerMutation();
  const value = assignment?.ownerAssigned
    ? assignment.ownerCreditId === null
      ? "none"
      : `credit:${assignment.ownerCreditId}`
    : "auto";
  const autoName = credits.find((credit) => credit.id === assignment?.automaticCreditId)?.name ?? "其他权益";
  return (
    <div className="mt-1 min-w-0 space-y-1">
      <select
        aria-label="归属报销项目"
        value={value}
        disabled={mutation.pending}
        className="h-9 w-auto max-w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs focus:ring-2 focus:ring-ring disabled:opacity-60"
        onChange={(event) => {
          const choice = event.currentTarget.value;
          void mutation.run(async () => {
            await api("/api/benefits/assignments", "PUT", {
              entryId,
              productId,
              ...(choice.startsWith("credit:")
                ? { mode: "credit", creditId: choice.slice(7) }
                : { mode: choice }),
            });
          });
        }}
      >
        <option value="auto">自动匹配（{autoName}）</option>
        {credits.map((credit) => (
          <option key={credit.id} value={`credit:${credit.id}`}>
            {credit.name}
          </option>
        ))}
        <option value="none">不计入报销项目</option>
      </select>
      <FormError error={mutation.error} />
    </div>
  );
}
