"use client";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, FormError, FormSheet, api, textField, useLedgerMutation } from "@/components/ledger/forms";
import { isStale } from "@/lib/money/fx";
import type { FxRate } from "./types";
export function FxManager({
  rates,
  today,
  baseCurrency,
  staleDays,
}: {
  rates: FxRate[];
  today: string;
  baseCurrency: string;
  staleDays: number;
}) {
  const [selected, setSelected] = useState<FxRate | "new" | null>(null);
  const [removing, setRemoving] = useState<FxRate | null>(null);
  const mutation = useLedgerMutation();
  const existing = selected && selected !== "new" ? selected : null;
  return (
    <>
      <Button className="mb-6" onClick={() => setSelected("new")}>
        <Plus size={16} />
        录入汇率
      </Button>
      <p className="mb-6 text-sm leading-7 text-muted-foreground">
        汇率表示每 1 单位基准币种对应多少原币。原币折算为基准币种时除以汇率；余额观察保存后，其汇率保持冻结。
      </p>
      <FormError error={mutation.error} />
      {!rates.length ? (
        <p className="rounded-xl border bg-card p-6 text-sm">
          还没有汇率。持有外币账户时，请记录对应日期的汇率。
        </p>
      ) : (
        <div className="space-y-3">
          {rates.map((rate) => (
            <article
              key={rate.id}
              className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card p-5"
            >
              <div>
                <p className="font-medium">
                  {rate.baseCurrency}/{rate.quoteCurrency}{" "}
                  <span className="ml-2 font-mono">{rate.rate.replace(/0+$/, "").replace(/\.$/, "")}</span>
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {rate.observedOn} · {rate.source}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={isStale(rate.observedOn, today, staleDays) ? "outline" : "secondary"}>
                  {isStale(rate.observedOn, today, staleDays)
                    ? "已过期"
                    : rate.observedOn > today
                      ? "未来日期"
                      : "近期观察"}
                </Badge>
                <Button variant="ghost" onClick={() => setSelected(rate)}>
                  编辑
                </Button>
                <Button variant="ghost" onClick={() => setRemoving(rate)}>
                  删除
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
      <FormSheet
        title={existing ? "编辑汇率" : "录入汇率"}
        description="修改目录不会改写已保存余额观察的汇率。"
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        {selected ? (
          <form
            key={existing?.id ?? "new"}
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void mutation.run(async () => {
                await api(
                  existing ? `/api/fx-rates/${existing.id}` : "/api/fx-rates",
                  existing ? "PATCH" : "POST",
                  {
                    baseCurrency: textField(data, "baseCurrency").toUpperCase(),
                    quoteCurrency: textField(data, "quoteCurrency").toUpperCase(),
                    rate: textField(data, "rate"),
                    observedOn: textField(data, "observedOn"),
                    source: textField(data, "source"),
                    isManual: true,
                  },
                );
                setSelected(null);
              });
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <Field
                name="baseCurrency"
                label="基准币种"
                defaultValue={existing?.baseCurrency ?? baseCurrency}
                maxLength={3}
                required
              />
              <Field
                name="quoteCurrency"
                label="原币"
                defaultValue={existing?.quoteCurrency ?? "CNY"}
                maxLength={3}
                required
              />
            </div>
            <Field
              name="rate"
              label="每 1 基准币种对应的原币数量"
              inputMode="decimal"
              defaultValue={existing?.rate}
              required
            />
            <Field
              name="observedOn"
              label="观察日期"
              type="date"
              defaultValue={existing?.observedOn ?? today}
              required
            />
            <Field
              name="source"
              label="来源"
              defaultValue={existing?.source ?? "手工观察"}
              required
              maxLength={200}
            />
            <FormError error={mutation.error} />
            <Button type="submit" disabled={mutation.pending} className="w-full">
              保存汇率
            </Button>
          </form>
        ) : null}
      </FormSheet>
      <FormSheet
        title="删除目录汇率"
        description="已冻结的余额观察汇率仍会保留。"
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <p className="mb-5 text-sm">
          {removing?.baseCurrency}/{removing?.quoteCurrency} · {removing?.observedOn}
        </p>
        <FormError error={mutation.error} />
        <Button
          disabled={mutation.pending}
          onClick={() =>
            void mutation.run(async () => {
              await api(`/api/fx-rates/${removing!.id}`, "DELETE");
              setRemoving(null);
            }, "汇率已删除")
          }
        >
          确认删除
        </Button>
      </FormSheet>
    </>
  );
}
