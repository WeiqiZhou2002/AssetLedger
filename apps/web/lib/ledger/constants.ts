export const accountTypes = [
  "asset_cash",
  "asset_brokerage_cash",
  "asset_security",
  "asset_receivable",
  "asset_prepaid",
  "liability_credit_card",
  "liability_loan",
  "income",
  "expense",
  "equity_opening",
  "fx_clearing",
  "transfer_clearing",
  "reconciliation_adjustment",
] as const;
export type AccountType = (typeof accountTypes)[number];
export const systemTypes = [
  "income",
  "expense",
  "equity_opening",
  "fx_clearing",
  "transfer_clearing",
  "reconciliation_adjustment",
] as const;
export type SystemType = (typeof systemTypes)[number];
export const realTypes = accountTypes.filter((type) => !systemTypes.includes(type as SystemType));
export const entryTypes = [
  "expense",
  "income",
  "transfer",
  "credit_card_payment",
  "refund",
  "investment_buy",
  "investment_sell",
  "loan_out",
  "loan_repayment",
  "prepayment",
  "fee",
  "interest",
  "balance_adjustment",
  "opening_balance",
] as const;
export type EntryType = (typeof entryTypes)[number];
export const accountLabels: Record<AccountType, string> = {
  asset_cash: "银行与现金",
  asset_brokerage_cash: "券商现金",
  asset_security: "证券投入",
  asset_receivable: "应收款",
  asset_prepaid: "预付款",
  liability_credit_card: "信用卡",
  liability_loan: "借款负债",
  income: "收入科目",
  expense: "支出科目",
  equity_opening: "期初权益",
  fx_clearing: "外汇清算",
  transfer_clearing: "待匹配转账",
  reconciliation_adjustment: "对账调整",
};
export const entryLabels: Record<EntryType, string> = {
  expense: "消费",
  income: "收入",
  transfer: "内部转账",
  credit_card_payment: "信用卡还款",
  refund: "退款",
  investment_buy: "投资买入",
  investment_sell: "投资卖出",
  loan_out: "借出",
  loan_repayment: "收回借款",
  prepayment: "预付款",
  fee: "手续费",
  interest: "利息",
  balance_adjustment: "余额调整",
  opening_balance: "期初余额",
};
export const cashTypes: AccountType[] = ["asset_cash", "asset_brokerage_cash"];
export const transferTypes: AccountType[] = [...cashTypes, "liability_loan"];
export const fundingTypes: AccountType[] = [...cashTypes, "liability_credit_card"];
export const cashLikeTypes: AccountType[] = [...fundingTypes, "liability_loan"];
export const expenseCategoryNames = [
  "餐饮",
  "日用杂货",
  "购物",
  "电子产品",
  "交通",
  "住房租金",
  "水电网络",
  "旅行",
  "娱乐",
  "医疗健康",
  "订阅服务",
  "教育",
  "礼物",
  "手续费",
  "利息支出",
  "税费",
  "其他支出",
];
export const incomeCategoryNames = ["工资", "奖金", "利息收入", "报销", "其他收入"];
