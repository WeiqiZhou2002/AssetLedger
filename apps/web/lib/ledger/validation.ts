import type { accounts, categories } from "@/db/schema";
import { money, sumMoney } from "@/lib/money";
import {
  cashTypes,
  fundingTypes,
  transferTypes,
  systemTypes,
  type AccountType,
  type SystemType,
} from "./constants";
import { invariant } from "./errors";
import type { ValidEntry } from "./schemas";
type Account = typeof accounts.$inferSelect;
type Category = typeof categories.$inferSelect;
export function validateEntry(
  entry: ValidEntry,
  ownerId: string,
  accountRows: Account[],
  categoryRows: Category[],
) {
  const accountMap = new Map(accountRows.map((row) => [row.id, row]));
  const categoryMap = new Map(categoryRows.map((row) => [row.id, row]));
  invariant(entry.postings.length >= 2, "至少需要两条分录");
  const lines = entry.postings.map((posting) => {
    const account = accountMap.get(posting.accountId);
    invariant(account && account.ownerId === ownerId, "账户不存在或不属于当前用户");
    invariant(account.currency === posting.currency, "分录币种必须与账户一致");
    const amount = money(posting.amount);
    invariant(!amount.isZero(), "金额不能为零");
    if (account.type === "expense" || account.type === "income") {
      const category = posting.categoryId ? categoryMap.get(posting.categoryId) : undefined;
      invariant(
        category && category.ownerId === ownerId && category.kind === account.type,
        "收支科目需要同类型分类",
      );
      invariant(!category.isArchived, "分类已归档");
    } else {
      invariant(!posting.categoryId, "非收支科目不能指定分类");
    }
    return { ...posting, type: account.type, positive: amount.gt(0), amount };
  });
  const currencies = [...new Set(lines.map((line) => line.currency))];
  for (const currency of currencies) {
    invariant(
      sumMoney(lines.filter((line) => line.currency === currency).map((line) => line.amount)).isZero(),
      "每个币种的借贷必须平衡",
    );
  }
  invariant(new Set(lines.map((line) => line.accountId)).size >= 2, "分录至少涉及两个不同账户");
  if (entry.entryType !== "transfer") {
    invariant(currencies.length === 1, "仅内部转账支持跨币种，请分别记录其他交易");
  }
  const has = (types: AccountType[], positive: boolean) =>
    lines.some((line) => line.positive === positive && types.includes(line.type));
  const only = (debit: AccountType[], credit: AccountType[]) => {
    invariant(
      lines.every((line) => (line.positive ? debit : credit).includes(line.type)),
      "该交易类型不允许此账户或借贷方向",
    );
  };
  const pair = (debit: AccountType[], credit: AccountType[]) => {
    only(debit, credit);
    invariant(has(debit, true) && has(credit, false), "缺少必要的借方或贷方");
  };
  invariant(
    entry.benefitCredit
      ? entry.entryType === "refund" &&
          Boolean(entry.benefitFamily) &&
          lines.filter((line) => line.type === "liability_credit_card" && line.positive).length === 1 &&
          lines.every((line) => line.type === "expense" || line.type === "liability_credit_card")
      : !entry.benefitFamily,
    "权益报销必须为信用卡退款并指定权益类型",
  );
  const transferLeg = lines.some((line) => line.type === "transfer_clearing");
  if (transferLeg) {
    invariant(
      ["transfer", "credit_card_payment"].includes(entry.entryType) &&
        currencies.length === 1 &&
        lines.length === 2 &&
        lines.filter((line) => line.type === "transfer_clearing").length === 1 &&
        lines.some((line) => [...transferTypes, "liability_credit_card"].includes(line.type)),
      "待匹配转账必须为同币种的一个现金、信用卡或借款账户及一条清算分录",
    );
    if (entry.entryType === "credit_card_payment") {
      invariant(
        lines.some(
          (line) =>
            (line.type === "liability_credit_card" && line.positive) ||
            (cashTypes.includes(line.type) && !line.positive),
        ),
        "还款清算分录须为信用卡入账或现金转出",
      );
    }
    invariant(!entry.refundOfEntryId, "只有退款可以关联原消费");
    return;
  }
  switch (entry.entryType) {
    case "expense":
      pair(["expense"], [...fundingTypes, "asset_prepaid"]);
      break;
    case "income":
      pair(fundingTypes, ["income"]);
      break;
    case "credit_card_payment":
      pair(["liability_credit_card"], cashTypes);
      break;
    case "refund":
      pair(fundingTypes, ["expense"]);
      break;
    case "investment_buy":
      only(["asset_security", "expense"], ["asset_brokerage_cash"]);
      invariant(
        has(["asset_security"], true) && has(["asset_brokerage_cash"], false),
        "买入需有证券和券商现金分录",
      );
      break;
    case "investment_sell":
      only(["asset_brokerage_cash", "expense"], ["asset_security"]);
      invariant(
        has(["asset_brokerage_cash"], true) && has(["asset_security"], false),
        "卖出需有证券和券商现金分录",
      );
      break;
    case "loan_out":
      pair(["asset_receivable"], fundingTypes);
      break;
    case "loan_repayment":
      pair(cashTypes, ["asset_receivable"]);
      break;
    case "prepayment":
      pair(["asset_prepaid"], fundingTypes);
      break;
    case "fee":
      pair(["expense"], fundingTypes);
      break;
    case "interest":
      if (has(["income"], false)) {
        pair(cashTypes, ["income"]);
      } else {
        pair(["expense"], fundingTypes);
      }
      break;
    case "transfer": {
      const allowed: AccountType[] = [...transferTypes, "fx_clearing"];
      only(allowed, allowed);
      invariant(
        has(transferTypes, true) && has(transferTypes, false),
        "转账需要现金或借款负债转出和转入账户",
      );
      if (currencies.length === 1) {
        invariant(!lines.some((line) => line.type === "fx_clearing"), "同币种转账不使用外汇清算");
      } else {
        for (const currency of currencies) {
          const clearing = lines.filter((line) => line.currency === currency && line.type === "fx_clearing");
          invariant(clearing.length === 1, "跨币种转账每个币种须有一条外汇清算分录");
          const cash = lines.filter(
            (line) => line.currency === currency && transferTypes.includes(line.type),
          );
          invariant(
            cash.length && cash.every((line) => line.positive !== clearing[0].positive),
            "每个币种清算方向须与现金流相反",
          );
        }
      }
      break;
    }
    case "opening_balance":
    case "balance_adjustment": {
      const counterpart =
        entry.entryType === "opening_balance" ? "equity_opening" : "reconciliation_adjustment";
      invariant(lines.length === 2, "期初或调整必须为一个真实账户和一个对应科目");
      invariant(
        lines.filter((line) => line.type === counterpart).length === 1 &&
          lines.filter((line) => !systemTypes.includes(line.type as SystemType)).length === 1,
        "期初或调整科目不正确",
      );
      if (entry.entryType === "balance_adjustment") {
        invariant(entry.notes?.trim(), "余额调整必须填写原因");
      }
      break;
    }
  }
  invariant(!entry.refundOfEntryId || entry.entryType === "refund", "只有退款可以关联原消费");
}
