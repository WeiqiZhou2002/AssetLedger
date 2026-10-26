"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FormError,
  FormSheet,
  NotesField,
  SelectField,
  api,
  textField,
  useLedgerMutation,
} from "@/components/ledger/forms";
import type { RewardsOverview } from "@/lib/rewards/queries";
import { eventLabels, manualEventTypes } from "@/lib/rewards/constants";
import { decimal } from "@/lib/money/fx";
type Account = RewardsOverview["accounts"][number];
export type RewardForm =
  | { kind: "account"; account?: Account; programId?: string }
  | { kind: "event" | "observation"; accountId?: string }
  | { kind: "transfer" }
  | { kind: "cpp"; programId?: string }
  | { kind: "program" };
export function RewardEditor({
  form,
  data,
  cards,
  onClose,
}: {
  form: RewardForm;
  data: RewardsOverview;
  cards: { id: string; name: string }[];
  onClose: () => void;
}) {
  const mutation = useLedgerMutation();
  const [fromPoints, setFromPoints] = useState("");
  const [toPoints, setToPoints] = useState("");
  const programs =
    form.kind === "cpp"
      ? data.programs.filter((program) => data.accounts.some((account) => account.programId === program.id))
      : data.programs;
  const [programId, setProgramId] = useState(
    "programId" in form && form.programId
      ? form.programId
      : form.kind === "account"
        ? ""
        : (programs[0]?.id ?? ""),
  );
  const cpp = [...data.history]
    .reverse()
    .find((row) => row.programId === programId && row.effectiveDate <= data.asOf);
  const accounts = data.accounts.filter((row) => row.isActive && !row.program.isArchived);
  const titles = {
    account: "积分账户",
    event: "记录积分变动",
    observation: "录入日终点数",
    transfer: "积分转点",
    cpp: "调整 CPP 假设",
    program: "新增积分项目",
  };
  const accountSelect = (name: string, label: string, value?: string, code?: string) => (
    <SelectField name={name} label={label} defaultValue={value ?? ""} required>
      <option value="">请选择积分账户</option>
      {accounts
        .filter((account) => !code || account.program.code === code)
        .map((account) => (
          <option key={account.id} value={account.id}>
            {account.program.code} · {account.name}
          </option>
        ))}
    </SelectField>
  );
  async function submit(fields: FormData) {
    const text = (name: string) => textField(fields, name);
    const optional = (name: string) => text(name) || null;
    if (form.kind === "account") {
      await api(
        `/api/loyalty/accounts${form.account ? `/${form.account.id}` : ""}`,
        form.account ? "PATCH" : "POST",
        {
          ...(!form.account ? { programId: text("programId") } : {}),
          name: text("name"),
          memberLast4: optional("memberLast4"),
          linkedCardAccountId: optional("linkedCardAccountId"),
          notes: optional("notes"),
          isActive: text("isActive") === "true",
        },
      );
    } else if (form.kind === "event") {
      await api("/api/loyalty/events", "POST", {
        loyaltyAccountId: text("loyaltyAccountId"),
        eventDate: text("date"),
        type: text("type"),
        pointsDelta: text("points"),
        relatedJournalEntryId: optional("relatedJournalEntryId"),
        note: optional("notes"),
      });
    } else if (form.kind === "observation") {
      await api("/api/loyalty/observations", "POST", {
        loyaltyAccountId: text("loyaltyAccountId"),
        observedOn: text("date"),
        balance: text("points"),
      });
    } else if (form.kind === "transfer") {
      await api("/api/loyalty/transfers", "POST", {
        fromAccountId: text("fromAccountId"),
        toAccountId: text("toAccountId"),
        fromPoints: text("fromPoints"),
        toPoints: text("toPoints"),
        eventDate: text("date"),
        note: optional("notes"),
      });
    } else if (form.kind === "cpp") {
      await api("/api/valuation-rules", "POST", {
        programId: text("programId"),
        effectiveDate: text("date"),
        cppBaseline: text("cppBaseline"),
        cppPersonal: text("cppPersonal"),
        note: optional("notes"),
      });
    } else if (form.kind === "program") {
      await api("/api/loyalty/programs", "POST", {
        code: text("code"),
        name: text("name"),
        kind: text("kind"),
        unitLabel: text("unitLabel"),
      });
    }
    onClose();
  }
  return (
    <FormSheet
      title={titles[form.kind]}
      description="积分以整数记录；估值只作参考，不计入现金资产。"
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <form
        className="mt-5 space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          void mutation.run(() => submit(fields));
        }}
      >
        {form.kind === "account" ? (
          <>
            {!form.account ? (
              <>
                <SelectField
                  name="programId"
                  label="积分项目"
                  value={programId}
                  onChange={(event) => setProgramId(event.target.value)}
                  required
                >
                  <option value="">选择项目</option>
                  {data.programs.map((row) => (
                    <option value={row.id} key={row.id}>
                      {row.code} · {row.name}
                      {row.isArchived ? " · 已归档" : ""}
                    </option>
                  ))}
                </SelectField>
                {data.programs.find((row) => row.id === programId)?.isArchived ? (
                  <p className="text-xs leading-6 text-muted-foreground">
                    添加账户会恢复此项目，保留原有 CPP 历史。
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{form.account.program.name}</p>
            )}
            <Field name="name" label="账户名称" required maxLength={100} defaultValue={form.account?.name} />
            <Field
              name="memberLast4"
              label="会员号末四位（选填）"
              maxLength={4}
              pattern="[A-Za-z0-9]{4}"
              defaultValue={form.account?.memberLast4 ?? ""}
            />
            <SelectField
              name="linkedCardAccountId"
              label="关联信用卡（用于账单积分确认）"
              defaultValue={form.account?.linkedCardAccountId ?? ""}
            >
              <option value="">不关联</option>
              {cards.map((card) => (
                <option key={card.id} value={card.id}>
                  {card.name}
                </option>
              ))}
            </SelectField>
            <SelectField
              name="isActive"
              label="账户状态"
              defaultValue={form.account?.isActive === false ? "false" : "true"}
            >
              <option value="true">启用</option>
              <option value="false">停用（保留历史）</option>
            </SelectField>
            <NotesField name="notes" defaultValue={form.account?.notes ?? ""} />
          </>
        ) : null}
        {form.kind === "event" || form.kind === "observation" ? (
          <>
            {accountSelect("loyaltyAccountId", "积分账户", form.accountId)}
            <Field
              name="date"
              label={form.kind === "event" ? "发生日期" : "观察日期（日终）"}
              type="date"
              defaultValue={data.asOf}
              required
            />
            {form.kind === "event" ? (
              <SelectField name="type" label="变动类型" defaultValue="earn">
                {manualEventTypes.map((type) => (
                  <option key={type} value={type}>
                    {eventLabels[type]}
                  </option>
                ))}
              </SelectField>
            ) : (
              <p className="text-xs leading-6 text-muted-foreground">
                观察包含当天全部变动。对账差额单独展示，不会自动补记事件；同一账户同一天只能保留一份观察。
              </p>
            )}
            <Field
              name="points"
              label={form.kind === "event" ? "点数变动（兑换、过期填负数）" : "实际点数余额"}
              inputMode="numeric"
              pattern="-?[0-9]+"
              required
            />
            {form.kind === "event" ? (
              <>
                <Field name="relatedJournalEntryId" label="关联流水 ID（选填，仅供说明）" />
                <NotesField name="notes" />
              </>
            ) : null}
          </>
        ) : null}
        {form.kind === "transfer" ? (
          <>
            {accountSelect("fromAccountId", "转出账户")}
            {accountSelect("toAccountId", "转入账户")}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                name="fromPoints"
                label="扣除点数"
                inputMode="numeric"
                pattern="[0-9]+"
                value={fromPoints}
                onChange={(event) => setFromPoints(event.target.value)}
                required
              />
              <Field
                name="toPoints"
                label="收到点数（含奖励）"
                inputMode="numeric"
                pattern="[0-9]+"
                value={toPoints}
                onChange={(event) => setToPoints(event.target.value)}
                required
              />
            </div>
            <p className="rounded-xl bg-muted p-4 text-sm">
              比例 {fromPoints || "—"} : {toPoints || "—"}
              {/^\d+$/.test(fromPoints) && /^\d+$/.test(toPoints) && BigInt(fromPoints) > 0n
                ? ` · 每转出 1 点收到 ${decimal(toPoints).div(fromPoints).toFixed(4)} 点`
                : ""}
            </p>
            <Field name="date" label="转点日期" type="date" defaultValue={data.asOf} required />
            <NotesField name="notes" />
          </>
        ) : null}
        {form.kind === "cpp" ? (
          <>
            <SelectField
              name="programId"
              label="积分项目"
              value={programId}
              onChange={(event) => setProgramId(event.target.value)}
            >
              {programs.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.code} · {row.name}
                </option>
              ))}
            </SelectField>
            <Field name="date" label="生效日期" type="date" defaultValue={data.asOf} required />
            <div key={programId} className="grid gap-4 sm:grid-cols-2">
              <Field
                name="cppBaseline"
                label="基准 CPP（美分/点）"
                inputMode="decimal"
                defaultValue={cpp?.cppBaseline ?? "1"}
                required
              />
              <Field
                name="cppPersonal"
                label="个人 CPP（美分/点）"
                inputMode="decimal"
                defaultValue={cpp?.cppPersonal ?? "1"}
                required
              />
            </div>
            <p className="text-xs leading-6 text-muted-foreground">
              按日期使用当时最近的估值。相同项目、相同生效日再次保存会修正当天规则；新增日期会保留之前规则。
            </p>
            <NotesField name="notes" />
          </>
        ) : null}
        {form.kind === "program" ? (
          <>
            <Field
              name="code"
              label="项目代码（大写，不可更改）"
              pattern="[A-Z0-9_]+"
              required
              maxLength={30}
            />
            <Field name="name" label="正式名称" required />
            <SelectField name="kind" label="类型">
              <option value="bank_points">银行积分</option>
              <option value="airline">航空里程</option>
              <option value="hotel">酒店积分</option>
              <option value="cashback">返现奖励</option>
              <option value="other">其他</option>
            </SelectField>
            <Field name="unitLabel" label="单位" defaultValue="点" required />
          </>
        ) : null}
        <FormError error={mutation.error} />
        <Button className="w-full" disabled={mutation.pending}>
          {mutation.pending ? "保存中…" : "保存记录"}
        </Button>
      </form>
    </FormSheet>
  );
}
