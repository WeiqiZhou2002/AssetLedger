import { money } from "@/lib/money";
import type { AppDb } from "@/db/types";
import type { accounts } from "@/db/schema";
import { getSystemAccount, requireAccount } from "./accounts";
import { listCategories } from "./categories";
import { getSettings } from "./settings";
import { createEntry } from "./entries";
import { invariant } from "./errors";
import { quickSchema, type EntryInput, type PostingInput, type QuickInput } from "./schemas";
import type { EntryType, SystemType } from "./constants";
type Account = typeof accounts.$inferSelect;
export async function buildPostings(
  db: AppDb,
  ownerId: string,
  type: EntryType,
  input: Omit<QuickInput, "type">,
): Promise<EntryInput> {
  const parsed = quickSchema.parse({ ...input, type });
  const {
    fromAccountId,
    toAccountId,
    amount,
    categoryId,
    feeAmount,
    feeCategoryId,
    toAmount,
    interestDirection,
    ...meta
  } = parsed;
  const from = fromAccountId ? await requireAccount(db, ownerId, fromAccountId) : null;
  const to = toAccountId ? await requireAccount(db, ownerId, toAccountId) : null;
  const rows: PostingInput[] = [];
  const add = (account: Account, value: string, category?: string | null) => {
    rows.push({
      accountId: account.id,
      amount: value,
      currency: account.currency,
      categoryId: category ?? null,
    });
  };
  const required = (account: Account | null) => {
    invariant(account && !account.isSystem, "请选择真实账户");
    return account;
  };
  const nominal = (kind: SystemType, currency: string) => getSystemAccount(db, ownerId, kind, currency);
  invariant(
    !feeAmount || type === "investment_buy" || type === "investment_sell",
    "仅投资买卖支持附加手续费",
  );
  invariant(
    !toAmount || (type === "transfer" && from && to && from.currency !== to.currency),
    "只有跨币种转账需要到账金额",
  );
  let actualType = type;
  const value = money(amount);
  invariant(["opening_balance", "balance_adjustment"].includes(type) || value.gt(0), "金额必须大于零");
  let chosenCategory = categoryId;
  if (type === "prepayment" && (await getSettings(db, ownerId)).prepaymentMode === "expense") {
    actualType = "expense";
    chosenCategory = (await listCategories(db, ownerId)).find(
      (category) => category.name === "住房租金" && category.kind === "expense" && !category.isArchived,
    )?.id;
    invariant(chosenCategory, "请先恢复或创建住房租金分类");
  }
  const debitExpense =
    actualType === "expense" || type === "fee" || (type === "interest" && interestDirection === "expense");
  const creditIncome = type === "income" || (type === "interest" && interestDirection === "income");
  if (debitExpense) {
    const account = required(from);
    add(await nominal("expense", account.currency), value.toFixed(4), chosenCategory);
    add(account, value.negated().toFixed(4));
  } else if (creditIncome) {
    const account = required(to);
    add(account, value.toFixed(4));
    add(await nominal("income", account.currency), value.negated().toFixed(4), chosenCategory);
  } else if (type === "refund") {
    const account = required(to);
    add(account, value.toFixed(4));
    add(await nominal("expense", account.currency), value.negated().toFixed(4), chosenCategory);
  } else if (type === "opening_balance" || type === "balance_adjustment") {
    const account = required(to);
    add(account, value.toFixed(4));
    add(
      await nominal(
        type === "opening_balance" ? "equity_opening" : "reconciliation_adjustment",
        account.currency,
      ),
      value.negated().toFixed(4),
    );
  } else {
    const source = required(from);
    const destination = required(to);
    invariant(source.id !== destination.id, "转出和转入账户不能相同");
    if (type === "transfer" && source.currency !== destination.currency) {
      invariant(toAmount && money(toAmount).gt(0), "跨币种转账需要实际到账金额");
      add(source, value.negated().toFixed(4));
      add(await nominal("fx_clearing", source.currency), value.toFixed(4));
      add(destination, money(toAmount).toFixed(4));
      add(await nominal("fx_clearing", destination.currency), money(toAmount).negated().toFixed(4));
    } else {
      invariant(source.currency === destination.currency, "此交易需要同币种账户");
      const fee = money(feeAmount ?? "0");
      invariant(
        fee.isZero() || type === "investment_buy" || type === "investment_sell",
        "仅投资买卖支持附加手续费",
      );
      const sourceAmount = type === "investment_buy" ? value.plus(fee) : value;
      const destinationAmount = type === "investment_sell" ? value.minus(fee) : value;
      invariant(destinationAmount.gt(0), "卖出到账金额须大于手续费");
      add(source, sourceAmount.negated().toFixed(4));
      add(destination, destinationAmount.toFixed(4));
      if (fee.gt(0)) {
        add(await nominal("expense", source.currency), fee.toFixed(4), feeCategoryId);
      }
    }
  }
  return {
    entryType: actualType,
    isSummary: meta.isSummary,
    status: meta.status,
    eventDate: meta.eventDate,
    postedDate: meta.postedDate,
    merchant: meta.merchant,
    description: meta.description,
    notes: meta.notes,
    purchaseGroupId: meta.purchaseGroupId,
    refundOfEntryId: meta.refundOfEntryId,
    postings: rows,
  };
}
export async function createQuickEntry(db: AppDb, ownerId: string, input: QuickInput) {
  const { type, ...values } = quickSchema.parse(input);
  return db.transaction(async (tx) =>
    createEntry(tx, ownerId, await buildPostings(tx, ownerId, type, values)),
  );
}
