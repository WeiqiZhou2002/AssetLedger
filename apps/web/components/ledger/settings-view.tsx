"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, FormError, FormSheet, SelectField, api, textField, useLedgerMutation } from "./forms";
import type { Category } from "./types";
export function LedgerSettings({
  settings,
  categories,
}: {
  settings: { prepaymentMode: "asset" | "expense"; spendingDateBasis: "posted" | "event" };
  categories: Category[];
}) {
  const [editing, setEditing] = useState<Category | "new" | null>(null);
  const [kind, setKind] = useState<"expense" | "income">("expense");
  const [deleting, setDeleting] = useState<Category | null>(null);
  const mutation = useLedgerMutation();
  const selected = editing && editing !== "new" ? editing : null;
  return (
    <div className="space-y-7">
      <section className="rounded-xl border bg-card p-5 sm:p-7">
        <h2 className="mb-5 font-medium">记账偏好</h2>
        <form
          className="max-w-xl space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void mutation.run(async () => {
              await api("/api/settings", "PATCH", {
                prepaymentMode: textField(data, "prepaymentMode"),
                spendingDateBasis: textField(data, "spendingDateBasis"),
              });
            });
          }}
        >
          <SelectField name="prepaymentMode" label="预付款处理方式" defaultValue={settings.prepaymentMode}>
            <option value="asset">先记为预付款资产</option>
            <option value="expense">立即计为住房租金消费</option>
          </SelectField>
          <p className="text-xs leading-6 text-muted-foreground">
            影响以后快速录入的预付款，不改变已存在的流水。资产模式下，使用消费从预付款账户摊销。
          </p>
          <SelectField
            name="spendingDateBasis"
            label="消费统计日期口径"
            defaultValue={settings.spendingDateBasis}
          >
            <option value="posted">入账日，缺失时用发生日</option>
            <option value="event">发生日</option>
          </SelectField>
          <Button disabled={mutation.pending} type="submit">
            保存偏好
          </Button>
        </form>
      </section>
      <section className="rounded-xl border bg-card p-5 sm:p-7">
        <div className="mb-6 flex items-center justify-between gap-3">
          <h2 className="font-medium">分类管理</h2>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing("new");
              setKind("expense");
            }}
          >
            新增分类
          </Button>
        </div>
        {(["expense", "income"] as const).map((type) => (
          <div key={type} className="mb-6">
            <h3 className="mb-3 text-xs text-muted-foreground">
              {type === "expense" ? "支出分类" : "收入分类"}
            </h3>
            <div className="divide-y">
              {categories
                .filter((category) => category.kind === type)
                .map((category) => (
                  <div key={category.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <div className="min-w-0">
                      <span className="text-sm">
                        {category.parentId
                          ? `${categories.find((row) => row.id === category.parentId)?.name ?? "父分类"} / `
                          : ""}
                        {category.name}
                      </span>
                      {category.isArchived ? (
                        <Badge variant="outline" className="ml-2">
                          已归档
                        </Badge>
                      ) : null}
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditing(category);
                          setKind(category.kind);
                        }}
                      >
                        编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={mutation.pending}
                        onClick={() =>
                          mutation.run(async () => {
                            await api(`/api/categories/${category.id}`, "PATCH", {
                              isArchived: !category.isArchived,
                            });
                          })
                        }
                      >
                        {category.isArchived ? "恢复" : "归档"}
                      </Button>
                      {!category.isSystem ? (
                        <Button size="sm" variant="ghost" onClick={() => setDeleting(category)}>
                          删除
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        ))}
      </section>
      <FormError error={mutation.error} />
      <FormSheet
        title={selected ? "编辑分类" : "新增分类"}
        description="归档会保留历史记录，新的交易不再使用此分类。"
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
                  selected ? `/api/categories/${selected.id}` : "/api/categories",
                  selected ? "PATCH" : "POST",
                  {
                    name: textField(data, "name"),
                    kind,
                    parentId: textField(data, "parentId") || null,
                    icon: textField(data, "icon") || null,
                    sortOrder: Number(textField(data, "sortOrder") || "0"),
                  },
                );
                setEditing(null);
              });
            }}
          >
            <Field name="name" label="分类名称" defaultValue={selected?.name} maxLength={80} required />
            <SelectField
              label="类型"
              value={kind}
              onChange={(event) => setKind(event.target.value as "expense" | "income")}
            >
              <option value="expense">支出</option>
              <option value="income">收入</option>
            </SelectField>
            <SelectField name="parentId" label="父分类（可选）" defaultValue={selected?.parentId ?? ""}>
              <option value="">顶级分类</option>
              {categories
                .filter(
                  (category) =>
                    category.kind === kind && category.id !== selected?.id && !category.isArchived,
                )
                .map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
            </SelectField>
            <Field name="icon" label="图标名称（可选）" defaultValue={selected?.icon ?? ""} maxLength={40} />
            <Field
              name="sortOrder"
              label="排序值"
              type="number"
              min={-10000}
              max={10000}
              defaultValue={selected?.sortOrder ?? 0}
            />
            <FormError error={mutation.error} />
            <Button type="submit" disabled={mutation.pending}>
              保存分类
            </Button>
          </form>
        ) : null}
      </FormSheet>
      <FormSheet
        title="删除分类"
        description="仅可删除未使用的自定义分类；已有记录请使用归档。"
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        {deleting ? (
          <div className="space-y-5">
            <p>删除「{deleting.name}」？</p>
            <FormError error={mutation.error} />
            <Button
              variant="destructive"
              disabled={mutation.pending}
              onClick={() =>
                mutation.run(async () => {
                  await api(`/api/categories/${deleting.id}`, "DELETE");
                  setDeleting(null);
                }, "分类已删除")
              }
            >
              确认删除
            </Button>
          </div>
        ) : null}
      </FormSheet>
    </div>
  );
}
