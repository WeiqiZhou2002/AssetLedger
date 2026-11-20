"use client";
import { Button } from "@/components/ui/button";
import { FormError, SelectField, api, textField, useLedgerMutation } from "@/components/ledger/forms";
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
        ...(textField(data, "productId") === "auto"
          ? { mode: "auto" }
          : textField(data, "productId") === "none"
            ? { mode: "none" }
            : { mode: "product", productId: textField(data, "productId") }),
      });
    });
  }
  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border p-4">
      <SelectField
        label="卡产品"
        name="productId"
        defaultValue={
          card.productSource === "none"
            ? "none"
            : card.productSource === "manual" && !stale
              ? (card.catalog?.productId ?? "auto")
              : "auto"
        }
        disabled={mutation.pending}
      >
        <option value="auto">
          自动匹配（{products.find((product) => product.id === card.autoProductId)?.name ?? "未找到"}）
        </option>
        {suggested.length ? (
          <optgroup label="建议产品">
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
        <option value="none">不在目录中，不跟踪</option>
      </SelectField>
      {stale ? (
        <p role="status" className="text-sm text-destructive">
          已选卡产品不在当前目录中，请重新选择。
        </p>
      ) : null}
      <FormError error={mutation.error} />
      <Button type="submit" size="sm" disabled={mutation.pending}>
        {mutation.pending ? "保存中…" : "保存卡产品"}
      </Button>
    </form>
  );
}
