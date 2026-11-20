"use client";
import { api, FormError, useLedgerMutation } from "@/components/ledger/forms";
export function BenefitMarkCheckbox({
  accountId,
  productId,
  creditId,
  periodStart,
  periodEnd,
  marked = false,
  label,
}: {
  accountId: string;
  productId: string;
  creditId: string;
  periodStart: string;
  periodEnd: string;
  marked?: boolean;
  label: string;
}) {
  const mutation = useLedgerMutation();
  return (
    <div className="mt-2 space-y-2">
      <label className="inline-flex cursor-pointer items-center gap-2 text-xs leading-6 has-disabled:opacity-60">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={marked}
          disabled={mutation.pending}
          onChange={(event) => {
            const checked = event.currentTarget.checked;
            void mutation.run(async () => {
              await api("/api/benefits/marks", "PUT", {
                accountId,
                productId,
                creditId,
                periodStart,
                periodEnd,
                marked: checked,
              });
            });
          }}
        />
        {label}
      </label>
      <FormError error={mutation.error} />
    </div>
  );
}
