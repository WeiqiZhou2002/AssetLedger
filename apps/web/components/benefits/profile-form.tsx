"use client";
import { Button } from "@/components/ui/button";
import { Field, FormError, SelectField, api, textField, useLedgerMutation } from "@/components/ledger/forms";
import type { BenefitCard, BenefitData } from "./types";
export function BenefitProfileForm({
  card,
  products,
}: {
  card: BenefitCard;
  products: BenefitData["products"];
}) {
  const mutation = useLedgerMutation();
  const suggested = card.suggestedProductIds.flatMap((id) => products.filter((product) => product.id === id));
  const issuers = [...new Set(products.map((product) => product.issuer))];
  const stale = card.catalog?.stale;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await mutation.run(async () => {
      await api("/api/benefits/profile", "PUT", {
        accountId: card.accountId,
        productId: textField(data, "productId") || null,
        trackingStart: textField(data, "trackingStart") || null,
      });
    });
  }
  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border p-4">
      <SelectField
        label="卡产品"
        name="productId"
        defaultValue={stale ? "" : (card.catalog?.productId ?? "")}
        disabled={mutation.pending}
      >
        <option value="">未选择</option>
        {suggested.length ? (
          <optgroup label="建议产品（请确认）">
            {suggested.map((product) => (
              <option key={product.id} value={product.id}>
                {product.issuer} · {product.name}
              </option>
            ))}
          </optgroup>
        ) : null}
        {issuers.map((issuer) => (
          <optgroup key={issuer} label={issuer}>
            {products
              .filter((product) => product.issuer === issuer)
              .map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
          </optgroup>
        ))}
      </SelectField>
      {stale ? (
        <p role="status" className="text-sm text-destructive">
          已选卡产品不在当前目录中，请重新选择。
        </p>
      ) : null}
      <p className="text-xs leading-6 text-muted-foreground">
        选择后按发卡机构公开条款计算报销进度。建议产品需确认后保存。
      </p>
      <Field
        label="跟踪起始日（可选）"
        type="date"
        name="trackingStart"
        defaultValue={card.trackingStart ?? ""}
        disabled={mutation.pending}
      />
      <FormError error={mutation.error} />
      <Button type="submit" size="sm" disabled={mutation.pending}>
        {mutation.pending ? "保存中…" : "保存卡产品"}
      </Button>
    </form>
  );
}
