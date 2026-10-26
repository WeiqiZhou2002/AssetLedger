"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FormError, FormSheet, api, textField, useLedgerMutation } from "./forms";
import type { CardMeta } from "@/lib/ledger/card-secrets";
import type { CardPayload } from "@/lib/ledger/card-schema";
import type { Account } from "./types";

const networks = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "Amex",
  discover: "Discover",
  other: "其他卡片",
};
export function AccountCard({
  account,
  meta,
  totpEnabled,
}: {
  account: Account;
  meta?: CardMeta;
  totpEnabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const mutation = useLedgerMutation();
  if (account.isSystem || !["asset_cash", "liability_credit_card"].includes(account.type)) return null;
  return (
    <section className="mt-5 space-y-3 border-t pt-4" aria-label="卡片信息">
      <h4 className="text-sm font-medium">卡片信息</h4>
      <p className="text-xs leading-6 text-muted-foreground">
        {meta
          ? `${networks[meta.network]} •••• ${account.last4?.endsWith(meta.numberLast4) ? account.last4 : meta.numberLast4}${meta.hasExpiry ? " · 有效期已保存" : ""}${meta.hasCvv ? " · CVV 已保存" : ""}${meta.hasCid ? " · 正面 CID 已保存" : ""}`
          : "未保存"}
      </p>
      {meta && account.last4 && meta.numberLast4 !== account.last4.slice(-4) ? (
        <p className="text-xs text-amber-800">已保存卡片尾号与账户尾号 {account.last4} 不同，请核对。</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
          {meta ? "更新" : "保存"}
        </Button>
        {meta ? (
          <>
            <Button variant="outline" size="sm" onClick={() => setRevealing(true)}>
              查看
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={mutation.pending}
              onClick={() => {
                if (!window.confirm("删除已保存的卡片信息？账户和流水将保留。")) return;
                void mutation.run(async () => {
                  await api(`/api/accounts/${account.id}/card`, "DELETE");
                }, "卡片信息已删除");
              }}
            >
              删除
            </Button>
          </>
        ) : null}
      </div>
      <FormError error={mutation.error} />
      <FormSheet
        title={meta ? "更新卡片信息" : "保存卡片信息"}
        description="可选保存完整卡号、有效期和安全码。更新时请重新填写全部需保留的信息。"
        open={editing}
        onOpenChange={setEditing}
      >
        {editing ? (
          <CardForm accountId={account.id} accountLast4={account.last4} onSaved={() => setEditing(false)} />
        ) : null}
      </FormSheet>
      {revealing ? (
        <CardReveal accountId={account.id} totpEnabled={totpEnabled} onClose={() => setRevealing(false)} />
      ) : null}
    </section>
  );
}

function CardForm({
  accountId,
  accountLast4,
  onSaved,
}: {
  accountId: string;
  accountLast4: string | null;
  onSaved: () => void;
}) {
  const [number, setNumber] = useState("");
  const digits = number.replace(/[\s-]/g, "");
  const amex = /^3[47]/.test(digits);
  const mutation = useLedgerMutation();
  return (
    <form
      className="space-y-5"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        void mutation.run(async () => {
          await api(`/api/accounts/${accountId}/card`, "PUT", {
            number: textField(data, "number"),
            expMonth: textField(data, "expMonth"),
            expYear: textField(data, "expYear"),
            ...(textField(data, "cvv") ? { cvv: textField(data, "cvv") } : {}),
            ...(amex && textField(data, "cid") ? { cid: textField(data, "cid") } : {}),
          });
          form.reset();
          setNumber("");
          onSaved();
        }, "卡片信息已保存");
      }}
    >
      <Field
        name="number"
        label="完整卡号"
        autoComplete="off"
        inputMode="numeric"
        value={number}
        onChange={(event) => setNumber(event.target.value)}
        maxLength={32}
        required
      />
      {accountLast4 && digits.length >= 12 && !digits.endsWith(accountLast4) ? (
        <p className="text-xs text-amber-800">此卡尾号与账户尾号 {accountLast4} 不同，仍可保存。</p>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <Field
          name="expMonth"
          label="有效期月份（MM）"
          autoComplete="off"
          inputMode="numeric"
          pattern="0?[1-9]|1[0-2]"
          maxLength={2}
          required
        />
        <Field
          name="expYear"
          label="有效期年份（YY / YYYY）"
          autoComplete="off"
          inputMode="numeric"
          pattern="[0-9]{2}|[0-9]{4}"
          maxLength={4}
          required
        />
      </div>
      <Field
        key={amex ? "amex-cvv" : "cvv"}
        name="cvv"
        label={amex ? "背面 3 位 CVV（可选）" : "CVV（可选）"}
        type="password"
        autoComplete="off"
        inputMode="numeric"
        pattern={amex ? "[0-9]{3}" : "[0-9]{3,4}"}
        maxLength={amex ? 3 : 4}
      />
      {amex ? (
        <Field
          name="cid"
          label="正面 4 位 CID（可选）"
          type="password"
          autoComplete="off"
          inputMode="numeric"
          pattern="[0-9]{4}"
          maxLength={4}
        />
      ) : null}
      <FormError error={mutation.error} />
      <Button type="submit" disabled={mutation.pending} className="w-full">
        保存卡片信息
      </Button>
    </form>
  );
}

function CardReveal({
  accountId,
  totpEnabled,
  onClose,
}: {
  accountId: string;
  totpEnabled: boolean;
  onClose: () => void;
}) {
  const [card, setCard] = useState<CardPayload | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    if (!card) return;
    const timer = setTimeout(() => closeRef.current(), 60_000);
    return () => clearTimeout(timer);
  }, [card]);
  const close = () => {
    requestRef.current?.abort();
    setCard(null);
    setError("");
    onClose();
  };
  const expiry = card ? `${card.expMonth}/${card.expYear.slice(-2)}` : "";
  const fields = card
    ? [
        {
          label: "卡号",
          value: card.number,
          display: /^3[47]/.test(card.number)
            ? `${card.number.slice(0, 4)} ${card.number.slice(4, 10)} ${card.number.slice(10)}`
            : card.number.match(/.{1,4}/g)!.join(" "),
        },
        { label: "有效期", value: expiry, display: expiry },
        ...(card.cvv ? [{ label: "CVV", value: card.cvv, display: card.cvv }] : []),
        ...(card.cid ? [{ label: "正面 CID", value: card.cid, display: card.cid }] : []),
      ]
    : [];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>查看卡片信息</DialogTitle>
          <DialogDescription>
            {card
              ? "60 秒后自动隐藏，关闭窗口会立即清除显示。"
              : totpEnabled
                ? "输入新的 6 位两步验证码；已使用的验证码不能重复使用。"
                : "尚未启用两步验证，请输入当前登录密码。"}
          </DialogDescription>
        </DialogHeader>
        {card ? (
          <div className="space-y-4">
            {fields.map((field) => (
              <div key={field.label} className="space-y-1">
                <p className="text-xs text-muted-foreground">{field.label}</p>
                <div className="flex items-center justify-between gap-3">
                  <p className="font-mono break-all">{field.display}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(field.value);
                        setError("");
                      } catch {
                        setError("复制失败，请手动复制");
                      }
                    }}
                    aria-label={`复制${field.label}`}
                  >
                    复制
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <form
            autoComplete="off"
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (pending) return;
              const form = event.currentTarget;
              const data = new FormData(form);
              const body = totpEnabled
                ? { code: textField(data, "code") }
                : { password: String(data.get("password") ?? "") };
              form.reset();
              setPending(true);
              setError("");
              const controller = new AbortController();
              requestRef.current = controller;
              try {
                const response = await fetch(`/api/accounts/${accountId}/card/reveal`, {
                  method: "POST",
                  cache: "no-store",
                  signal: controller.signal,
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(body),
                });
                if (!response.ok) {
                  const result = await response.json();
                  throw new Error(result.error ?? "验证失败，请重试");
                }
                const payload: CardPayload = await response.json();
                if (!controller.signal.aborted) setCard(payload);
              } catch (cause) {
                if (!controller.signal.aborted)
                  setError(cause instanceof Error ? cause.message : "暂时无法查看，请重试");
              } finally {
                if (!controller.signal.aborted) setPending(false);
              }
            }}
          >
            {totpEnabled ? (
              <Field
                label="6 位两步验证码"
                name="code"
                autoComplete="off"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
              />
            ) : (
              <Field
                label="登录密码"
                name="password"
                type="password"
                autoComplete="off"
                maxLength={1024}
                required
              />
            )}
            <Button type="submit" disabled={pending} className="w-full">
              验证并查看
            </Button>
          </form>
        )}
        <FormError error={error} />
      </DialogContent>
    </Dialog>
  );
}
