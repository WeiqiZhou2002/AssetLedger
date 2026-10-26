"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, FormError, SelectField, useLedgerMutation } from "@/components/ledger/forms";
import { benefitConfig, selectableBenefitFamilies, type BenefitFamily } from "@/lib/benefits/config";
export function BenefitEditor({
  entryId,
  enabled,
  isRefund,
  initialFamily,
  onSaved,
}: {
  entryId: string;
  enabled: boolean;
  isRefund: boolean;
  initialFamily: BenefitFamily;
  onSaved: () => void;
}) {
  const mutation = useLedgerMutation();
  const [family, setFamily] = useState<BenefitFamily>(initialFamily === "offer" ? "generic" : initialFamily);
  const save = (body: unknown) =>
    void mutation.run(async () => {
      await api(`/api/transactions/${entryId}/benefit`, "POST", body);
      onSaved();
    });
  return (
    <section className="space-y-3 rounded-xl border bg-muted/30 p-4">
      <h3 className="text-sm font-medium">卡权益报销</h3>
      <p className="text-xs leading-6 text-muted-foreground">
        记录权益返还，抵减支出，不计收入。转账改为权益报销会作废替换，已匹配的另一侧转入待处理。
      </p>
      <SelectField
        label="权益类型"
        value={family}
        onChange={(event) => setFamily(event.target.value as BenefitFamily)}
      >
        {selectableBenefitFamilies.map((key) => (
          <option key={key} value={key}>
            {benefitConfig[key].label}
          </option>
        ))}
      </SelectField>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={mutation.pending}
          onClick={() => save({ action: "set", enabled: true, family })}
        >
          {enabled ? "更新权益类型" : isRefund ? "设为权益报销" : "改为权益报销"}
        </Button>
        {enabled ? (
          <Button
            variant="ghost"
            disabled={mutation.pending}
            onClick={() => save({ action: "set", enabled: false })}
          >
            取消权益标记
          </Button>
        ) : null}
      </div>
      <FormError error={mutation.error} />
    </section>
  );
}
