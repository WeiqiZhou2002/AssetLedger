"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatAmount } from "@/lib/ledger/format";
import {
  Field,
  FormError,
  FormSheet,
  NotesField,
  SelectField,
  api,
  textField,
  useLedgerMutation,
} from "./forms";
import type { Category, Group } from "./types";
export function PurchaseGroupsView({ groups, categories }: { groups: Group[]; categories: Category[] }) {
  const [editing, setEditing] = useState<Group | "new" | null>(null);
  const mutation = useLedgerMutation();
  const selected = editing && editing !== "new" ? editing : null;
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">关联多笔付款与退款，核对一笔购买的总额。</p>
        <Button onClick={() => setEditing("new")} className="shrink-0">
          新建购物组
        </Button>
      </div>
      {groups.length ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {groups.map((group) => (
            <article key={group.id} className="rounded-xl border bg-card p-5">
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-medium">{group.title}</h3>
                <Badge variant={group.status === "reconciled" ? "default" : "outline"}>
                  {group.status === "reconciled" ? "已核对" : "待核对"}
                </Badge>
              </div>
              <dl className="mt-5 space-y-3 text-sm">
                {[
                  ["确认总价", group.confirmedTotal],
                  ["已确认净支出", group.actual],
                  ["差额", group.difference],
                ].map(([label, value]) => (
                  <div key={label} className="flex flex-wrap justify-between gap-2">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="font-mono text-xs">
                      {value === null ? "未设定" : formatAmount(value!, group.currency)}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="mt-4 text-xs leading-6 text-muted-foreground">
                差额 = 确认总价 − 已确认净支出。请在流水详情中关联或移除条目。
              </p>
              <Button variant="outline" size="sm" className="mt-4" onClick={() => setEditing(group)}>
                编辑购物组
              </Button>
            </article>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border bg-card p-8 text-sm leading-7 text-muted-foreground">
          还没有购物组。为分卡付款或分次购买建立一组，再从流水详情逐笔关联。购物组本身不会产生支出。
        </div>
      )}
      <FormSheet
        title={selected ? "编辑购物组" : "新建购物组"}
        description="总价只用于核对，实际支出来自已确认的关联流水。"
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing ? (
          <form
            key={selected?.id ?? "new"}
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void mutation.run(async () => {
                await api(
                  selected ? `/api/purchase-groups/${selected.id}` : "/api/purchase-groups",
                  selected ? "PATCH" : "POST",
                  {
                    title: textField(data, "title"),
                    confirmedTotal: textField(data, "total") || null,
                    currency: textField(data, "currency").toUpperCase(),
                    categoryId: textField(data, "categoryId") || null,
                    notes: textField(data, "notes") || null,
                  },
                );
                setEditing(null);
              });
            }}
          >
            <Field name="title" label="购买名称" defaultValue={selected?.title} required maxLength={150} />
            <Field
              name="total"
              label="确认总价（可暂不填写）"
              inputMode="decimal"
              defaultValue={selected?.confirmedTotal ?? ""}
            />
            <Field
              name="currency"
              label="币种"
              defaultValue={selected?.currency ?? "USD"}
              pattern="[A-Za-z]{3}"
              maxLength={3}
              required
            />
            <SelectField name="categoryId" label="分类（可选）" defaultValue={selected?.categoryId ?? ""}>
              <option value="">不指定</option>
              {categories
                .filter((category) => category.kind === "expense" && !category.isArchived)
                .map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
            </SelectField>
            <NotesField name="notes" defaultValue={selected?.notes ?? ""} />
            <FormError error={mutation.error} />
            <Button type="submit" disabled={mutation.pending}>
              保存购物组
            </Button>
          </form>
        ) : null}
      </FormSheet>
    </div>
  );
}
