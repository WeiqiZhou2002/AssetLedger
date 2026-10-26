import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { accounts, auditLogs, journalEntries, postings } from "@/db/schema";
import { createTestDb } from "./helpers/db";
import { ledgerFixture } from "./helpers/ledger";
import { createAccount, getSystemAccount, listAccounts, updateAccount } from "@/lib/ledger/accounts";
import { createCategory, listCategories, updateCategory } from "@/lib/ledger/categories";
import { buildPostings, createQuickEntry } from "@/lib/ledger/builders";
import {
  confirmEntry,
  createEntry,
  getEntry,
  replaceEntry,
  updateEntryMeta,
  voidEntry,
} from "@/lib/ledger/entries";
import { balancesAsOf, listEntries, spendingSummary, accountBalance } from "@/lib/ledger/queries";
import { createPurchaseGroup, linkGroupEntry, listPurchaseGroups } from "@/lib/ledger/purchase-groups";
import { updateSettings } from "@/lib/ledger/settings";
import { seedDemo } from "@/lib/ledger/seed";
import { rewardsOverview } from "@/lib/rewards/queries";
import { money, sumMoney } from "@/lib/money";
import type { EntryInput, QuickInput } from "@/lib/ledger/schemas";
import { loadDemoLedger } from "../../../fixtures/demo/demo-ledger";
import { wealthOverview } from "@/lib/dashboard/wealth";
let harness: Awaited<ReturnType<typeof createTestDb>>;
let f: Awaited<ReturnType<typeof ledgerFixture>>;
const date = "2026-10-15";
beforeAll(async () => {
  harness = await createTestDb();
});
afterAll(async () => {
  await harness.client.close();
});
beforeEach(async () => {
  await harness.db.execute(sql`truncate users cascade`);
  f = await ledgerFixture(harness.db);
});
const quick = (input: Omit<QuickInput, "eventDate">) =>
  createQuickEntry(harness.db, f.ownerId, { ...input, eventDate: date });
const spending = async () =>
  sumMoney(
    (
      await spendingSummary(harness.db, f.ownerId, {
        from: "2026-01-01",
        to: "2026-12-31",
        basis: "posted",
        groupBy: "category",
      })
    )
      .filter((row) => row.currency === "USD")
      .map((row) => row.amount),
  ).toFixed(2);
const cashLike = async () =>
  sumMoney(
    (await balancesAsOf(harness.db, f.ownerId, date))
      .filter((row) => row.cashLikeInclusion && row.currency === "USD")
      .map((row) => row.balance),
  ).toFixed(2);
const balance = (id: string) =>
  accountBalance(harness.db, f.ownerId, id, date).then((value) => money(value).toFixed(2));
it("loads a small idempotent demo with balanced entries and Plaid-style observations derived from the ledger", async () => {
  const demo = await loadDemoLedger(harness.db, f.ownerId);
  expect(demo.accounts).toHaveLength(3);
  const entries = await harness.db.select().from(journalEntries).where(eq(journalEntries.ownerId, f.ownerId));
  expect(entries).toHaveLength(6);
  for (const entry of entries) {
    const detail = await getEntry(harness.db, f.ownerId, entry.id);
    expect(sumMoney(detail.postings.map((row) => row.amount)).toFixed(4)).toBe("0.0000");
  }
  expect(await spending()).toBe("93.40");
  expect(await accountBalance(harness.db, f.ownerId, demo.accounts[0].id, "2026-10-24")).toBe("1026.6000");
  expect(await accountBalance(harness.db, f.ownerId, demo.accounts[1].id, "2026-10-24")).toBe("-20.0000");
  expect(await accountBalance(harness.db, f.ownerId, demo.accounts[2].id, "2026-10-24")).toBe("275.0000");
  expect((await wealthOverview(harness.db, f.ownerId, "2026-10-24", "USD", 7, 7)).netWorth).toBe(
    "1281.6000000000",
  );
  expect(demo.observation).toMatchObject({
    status: "published",
    source: "plaid",
    snapshotDate: "2026-10-24",
  });
  expect(demo.observation.items).toHaveLength(3);
  for (const item of demo.observation.items)
    expect(item.balanceNative).toBe(
      await accountBalance(harness.db, f.ownerId, item.accountId!, "2026-10-24"),
    );
  const repeat = await loadDemoLedger(harness.db, f.ownerId);
  expect(repeat.observation).toEqual(demo.observation);
  expect(repeat.accounts.map((row) => row.id)).toEqual(demo.accounts.map((row) => row.id));
  expect(await harness.db.select().from(journalEntries).where(eq(journalEntries.ownerId, f.ownerId))).toEqual(
    entries,
  );
  expect(await harness.db.select().from(journalEntries).where(eq(journalEntries.ownerId, f.otherId))).toEqual(
    [],
  );
});
describe("Phase 1 accounting acceptance", () => {
  it("records card statement income, loan transfers and verified summaries without double counting", async () => {
    const loan = await createAccount(harness.db, f.ownerId, {
      name: "Example Loan",
      type: "liability_loan",
      currency: "USD",
    });
    const credit = await quick({
      type: "income",
      amount: "25",
      toAccountId: f.card.id,
      categoryId: f.category("其他收入"),
      isSummary: true,
    });
    expect((await getEntry(harness.db, f.ownerId, credit.id)).isSummary).toBe(true);
    expect(await balance(f.card.id)).toBe("25.00");
    await quick({ type: "transfer", amount: "300", fromAccountId: loan.id, toAccountId: f.bank.id });
    await quick({ type: "transfer", amount: "100", fromAccountId: f.bank.id, toAccountId: loan.id });
    expect(await balance(loan.id)).toBe("-200.00");
    expect(await balance(f.bank.id)).toBe("200.00");
    expect(await spending()).toBe("0.00");
    await expect(
      createEntry(harness.db, f.ownerId, {
        entryType: "income",
        isSummary: true,
        eventDate: date,
        postings: [
          { accountId: f.card.id, currency: "USD", amount: "25" },
          { accountId: f.income.id, currency: "USD", amount: "-20", categoryId: f.category("其他收入") },
        ],
      }),
    ).rejects.toThrow("平衡");
  });
  it("card spend 116 then payment 116 counts spending once and payment nets to zero", async () => {
    await quick({
      type: "expense",
      amount: "116",
      fromAccountId: f.card.id,
      categoryId: f.category("日用杂货"),
    });
    expect(await spending()).toBe("116.00");
    expect(await cashLike()).toBe("-116.00");
    await quick({
      type: "credit_card_payment",
      amount: "116",
      fromAccountId: f.bank.id,
      toAccountId: f.card.id,
    });
    expect(await spending()).toBe("116.00");
    expect(await cashLike()).toBe("-116.00");
    expect(await balance(f.card.id)).toBe("0.00");
  });
  it("bank-to-brokerage 375 has no income, spending or cash-like change", async () => {
    await quick({ type: "transfer", amount: "375", fromAccountId: f.bank.id, toAccountId: f.broker.id });
    expect(await balance(f.broker.id)).toBe("375.00");
    expect(await balance(f.income.id)).toBe("0.00");
    expect(await cashLike()).toBe("0.00");
    expect(await spending()).toBe("0.00");
  });
  it("purchase group sums postings once and duplicate changes difference to -135", async () => {
    const group = await createPurchaseGroup(harness.db, f.ownerId, {
      title: "Synthetic computer",
      confirmedTotal: "600",
      currency: "USD",
    });
    const first = await quick({
      type: "expense",
      amount: "135",
      fromAccountId: f.card.id,
      categoryId: f.category("电子产品"),
    });
    await linkGroupEntry(harness.db, f.ownerId, group.id, first.id);
    await quick({
      type: "expense",
      amount: "465",
      fromAccountId: f.bank.id,
      categoryId: f.category("电子产品"),
      purchaseGroupId: group.id,
    });
    expect(await spending()).toBe("600.00");
    expect((await listPurchaseGroups(harness.db, f.ownerId))[0]).toMatchObject({
      status: "reconciled",
      difference: "0.0000",
    });
    const duplicate = await quick({
      type: "expense",
      amount: "135",
      fromAccountId: f.card.id,
      categoryId: f.category("电子产品"),
      purchaseGroupId: group.id,
    });
    expect((await listPurchaseGroups(harness.db, f.ownerId))[0]).toMatchObject({
      status: "open",
      difference: "-135.0000",
    });
    await voidEntry(harness.db, f.ownerId, duplicate.id, "合成重复记录");
    expect((await listPurchaseGroups(harness.db, f.ownerId))[0].status).toBe("reconciled");
    await linkGroupEntry(harness.db, f.ownerId, group.id, first.id, true);
    expect((await listPurchaseGroups(harness.db, f.ownerId))[0].difference).toBe("135.0000");
  });
  it("investment principal is investment cash flow, only explicit fees are spending", async () => {
    const buy = await quick({
      type: "investment_buy",
      amount: "1000",
      fromAccountId: f.broker.id,
      toAccountId: f.security.id,
    });
    expect(buy.entryType).toBe("investment_buy");
    expect(await balance(f.broker.id)).toBe("-1000.00");
    expect(await balance(f.security.id)).toBe("1000.00");
    expect(await spending()).toBe("0.00");
    expect(await cashLike()).toBe("-1000.00");
    await quick({
      type: "investment_sell",
      amount: "100",
      fromAccountId: f.security.id,
      toAccountId: f.broker.id,
      feeAmount: "2",
      feeCategoryId: f.category("手续费"),
    });
    expect(await balance(f.broker.id)).toBe("-902.00");
    expect(await spending()).toBe("2.00");
  });
  it("loan out 160 creates a receivable and no spending", async () => {
    await quick({ type: "loan_out", amount: "160", fromAccountId: f.bank.id, toAccountId: f.receivable.id });
    expect(await balance(f.receivable.id)).toBe("160.00");
    expect(await cashLike()).toBe("-160.00");
    expect(await spending()).toBe("0.00");
    await quick({
      type: "loan_repayment",
      amount: "60",
      fromAccountId: f.receivable.id,
      toAccountId: f.bank.id,
    });
    expect(await balance(f.receivable.id)).toBe("100.00");
  });
  it("refund 20 reduces spending and retains its original reference", async () => {
    const original = await quick({
      type: "expense",
      amount: "116",
      fromAccountId: f.card.id,
      categoryId: f.category("购物"),
    });
    const refund = await quick({
      type: "refund",
      amount: "20",
      toAccountId: f.card.id,
      categoryId: f.category("购物"),
      refundOfEntryId: original.id,
    });
    expect(refund.refundOfEntryId).toBe(original.id);
    expect(await spending()).toBe("96.00");
  });
  it("prepayment asset, amortization and expense setting keep cash and spending separate", async () => {
    await quick({ type: "prepayment", amount: "200", fromAccountId: f.bank.id, toAccountId: f.prepaid.id });
    expect(await spending()).toBe("0.00");
    expect(await cashLike()).toBe("-200.00");
    await quick({
      type: "expense",
      amount: "200",
      fromAccountId: f.prepaid.id,
      categoryId: f.category("住房租金"),
    });
    expect(await spending()).toBe("200.00");
    expect(await cashLike()).toBe("-200.00");
    await updateSettings(harness.db, f.ownerId, { prepaymentMode: "expense", spendingDateBasis: "event" });
    const immediate = await quick({
      type: "prepayment",
      amount: "200",
      fromAccountId: f.bank.id,
      toAccountId: f.prepaid.id,
    });
    expect(immediate.entryType).toBe("expense");
    expect(await spending()).toBe("400.00");
  });
  it("cross-currency transfer balances each currency via clearing", async () => {
    const entry = await quick({
      type: "transfer",
      amount: "100",
      toAmount: "670",
      fromAccountId: f.bank.id,
      toAccountId: f.wallet.id,
    });
    for (const currency of ["USD", "CNY"]) {
      expect(
        sumMoney(
          entry.postings.filter((line) => line.currency === currency).map((line) => line.amount),
        ).toFixed(2),
      ).toBe("0.00");
    }
    expect(await balance(f.wallet.id)).toBe("670.00");
    expect(await spending()).toBe("0.00");
    await expect(
      quick({ type: "transfer", amount: "100", fromAccountId: f.bank.id, toAccountId: f.wallet.id }),
    ).rejects.toThrow("实际到账");
  });
});
it("rejects invalid balance, currency, ownership, category, combinations, zero and float inputs", async () => {
  const valid = await buildPostings(harness.db, f.ownerId, "expense", {
    amount: "50",
    fromAccountId: f.bank.id,
    categoryId: f.category("购物"),
    eventDate: date,
  });
  const change = (mutate: (entry: EntryInput) => void) => {
    const copy = structuredClone(valid);
    mutate(copy);
    return createEntry(harness.db, f.ownerId, copy);
  };
  await expect(
    change((entry) => {
      entry.postings[0].amount = "51";
    }),
  ).rejects.toThrow("平衡");
  await expect(
    change((entry) => {
      entry.postings[0].currency = "CNY";
    }),
  ).rejects.toThrow("币种");
  const otherAccount = await createAccount(harness.db, f.otherId, {
    name: "Other account",
    type: "asset_cash",
    currency: "USD",
  });
  await expect(
    change((entry) => {
      entry.postings[1].accountId = otherAccount.id;
    }),
  ).rejects.toThrow("当前用户");
  await expect(
    change((entry) => {
      entry.postings[0].categoryId = f.category("工资");
    }),
  ).rejects.toThrow("同类型");
  await expect(
    change((entry) => {
      entry.postings[1].accountId = f.security.id;
    }),
  ).rejects.toThrow("账户或借贷方向");
  await expect(
    change((entry) => {
      entry.postings[0].amount = "0";
    }),
  ).rejects.toThrow();
  const float = { ...valid, postings: [{ ...valid.postings[0], amount: 0.1 }, valid.postings[1]] };
  await expect(createEntry(harness.db, f.ownerId, float as unknown as EntryInput)).rejects.toThrow();
  expect(
    await harness.db.select().from(journalEntries).where(eq(journalEntries.ownerId, f.ownerId)),
  ).toHaveLength(0);
});
it("drafts do not count; confirm, void, replace and metadata preserve audit and monetary history", async () => {
  const draft = await quick({
    type: "expense",
    amount: "30",
    fromAccountId: f.card.id,
    categoryId: f.category("购物"),
    status: "draft",
  });
  expect(await spending()).toBe("0.00");
  await confirmEntry(harness.db, f.ownerId, draft.id);
  expect(await spending()).toBe("30.00");
  await voidEntry(harness.db, f.ownerId, draft.id, "合成撤销");
  expect(await balance(f.card.id)).toBe("0.00");
  expect((await getEntry(harness.db, f.ownerId, draft.id)).postings).toHaveLength(2);
  const original = await quick({
    type: "expense",
    amount: "50",
    fromAccountId: f.bank.id,
    categoryId: f.category("购物"),
  });
  const replacementInput = await buildPostings(harness.db, f.ownerId, "expense", {
    amount: "70",
    fromAccountId: f.bank.id,
    categoryId: f.category("购物"),
    eventDate: date,
  });
  const replacement = await replaceEntry(
    harness.db,
    f.ownerId,
    original.id,
    replacementInput,
    "合成金额更正",
  );
  expect(replacement.replacesEntryId).toBe(original.id);
  expect(await spending()).toBe("70.00");
  await expect(
    updateEntryMeta(harness.db, f.ownerId, replacement.id, { eventDate: "2026-10-16" }),
  ).rejects.toThrow();
  const expenseLine = replacement.postings.find((line) => line.accountId === f.expense.id)!;
  await updateEntryMeta(harness.db, f.ownerId, replacement.id, {
    merchant: "Example Store",
    categories: [{ postingId: expenseLine.id, categoryId: f.category("电子产品") }],
  });
  const updated = await getEntry(harness.db, f.ownerId, replacement.id);
  expect(updated.audit.some((row) => row.action === "entry.meta")).toBe(true);
  expect(JSON.stringify(updated.audit)).not.toContain("Example Store");
  expect(updated.postings.find((line) => line.id === expenseLine.id)?.categoryId).toBe(
    f.category("电子产品"),
  );
  expect(await spending()).toBe("70.00");
  await expect(
    replaceEntry(
      harness.db,
      f.ownerId,
      replacement.id,
      {
        ...replacementInput,
        postings: [{ ...replacementInput.postings[0], amount: "71" }, replacementInput.postings[1]],
      },
      "失败应回滚",
    ),
  ).rejects.toThrow();
  expect((await getEntry(harness.db, f.ownerId, replacement.id)).status).toBe("confirmed");
});
it("balances and summaries honor posted fallback, event basis, inclusive windows, weeks and currencies", async () => {
  await createQuickEntry(harness.db, f.ownerId, {
    type: "expense",
    amount: "12.30",
    fromAccountId: f.card.id,
    categoryId: f.category("购物"),
    eventDate: "2026-09-30",
    postedDate: "2026-10-02",
  });
  expect(money(await accountBalance(harness.db, f.ownerId, f.card.id, "2026-09-30", "posted")).isZero()).toBe(
    true,
  );
  expect(
    money(await accountBalance(harness.db, f.ownerId, f.card.id, "2026-09-30", "event")).toFixed(2),
  ).toBe("-12.30");
  const monthly = await spendingSummary(harness.db, f.ownerId, {
    from: "2026-10-01",
    to: "2026-10-31",
    basis: "posted",
    groupBy: "month",
  });
  expect(monthly).toEqual([{ group: "2026-10", currency: "USD", amount: "12.3000" }]);
  const weekly = await spendingSummary(harness.db, f.ownerId, {
    from: "2026-10-01",
    to: "2026-10-31",
    basis: "posted",
    groupBy: "week",
  });
  expect(weekly[0].group).toBe("2026-09-28");
});
it("filters amount by debit total per currency and separates spending/cashflow views", async () => {
  const transfer = await quick({
    type: "transfer",
    amount: "100",
    fromAccountId: f.bank.id,
    toAccountId: f.wallet.id,
    toAmount: "670",
  });
  const prepaid = await quick({
    type: "expense",
    amount: "200",
    fromAccountId: f.prepaid.id,
    categoryId: f.category("住房租金"),
    merchant: "Example Rent",
  });
  expect(
    (await listEntries(harness.db, f.ownerId, { view: "spending" })).entries.map((entry) => entry.id),
  ).toEqual([prepaid.id]);
  expect(
    (await listEntries(harness.db, f.ownerId, { view: "cashflow" })).entries.map((entry) => entry.id),
  ).toEqual([transfer.id]);
  expect(
    (await listEntries(harness.db, f.ownerId, { minAmount: "600", maxAmount: "700", currency: "CNY" }))
      .entries[0].id,
  ).toBe(transfer.id);
  expect((await listEntries(harness.db, f.ownerId, { minAmount: "700" })).total).toBe(0);
  expect(
    (await listEntries(harness.db, f.ownerId, { merchant: "Rent", categoryId: f.category("住房租金") }))
      .total,
  ).toBe(1);
});
it("account defaults, ownership, nominal uniqueness and category hierarchy remain valid", async () => {
  expect(f.card.cashLikeInclusion).toBe(true);
  expect(f.wallet.cashLikeInclusion).toBe(false);
  expect(f.prepaid.financialInclusion).toBe(false);
  expect(await getSystemAccount(harness.db, f.ownerId, "expense", "USD")).toMatchObject({ id: f.expense.id });
  expect((await listAccounts(harness.db, f.ownerId)).some((row) => row.isSystem)).toBe(false);
  await updateAccount(harness.db, f.ownerId, f.wallet.id, { cashLikeInclusion: true });
  await expect(
    createAccount(harness.db, f.ownerId, { name: "invalid", type: "expense", currency: "USD" }),
  ).rejects.toThrow();
  await expect(
    createAccount(harness.db, f.ownerId, {
      name: "invalid card",
      type: "liability_credit_card",
      currency: "USD",
      last4: "123456789",
    }),
  ).rejects.toThrow();
  await quick({ type: "opening_balance", amount: "-20", toAccountId: f.card.id });
  await expect(updateAccount(harness.db, f.ownerId, f.card.id, { currency: "CNY" })).rejects.toThrow(
    "已有流水",
  );
  const parent = await createCategory(harness.db, f.ownerId, { name: "合成父分类", kind: "expense" });
  const child = await createCategory(harness.db, f.ownerId, {
    name: "合成子分类",
    kind: "expense",
    parentId: parent.id,
  });
  await expect(updateCategory(harness.db, f.ownerId, parent.id, { parentId: child.id })).rejects.toThrow(
    "循环",
  );
  const before = await listCategories(harness.db, f.ownerId);
  await updateCategory(harness.db, f.ownerId, f.category("购物"), {
    name: "合成购物重命名",
    isArchived: true,
  });
  expect(await listCategories(harness.db, f.ownerId)).toHaveLength(before.length);
});
it("200 deterministic randomized valid entries sum all account balances to zero per currency", async () => {
  let random = 48271;
  const values = ["0.01", "0.10", "1.07", "12.34", "67.89"];
  for (let i = 0; i < 200; i++) {
    random = (random * 16807) % 2147483647;
    const amount = values[random % values.length];
    const variants: Omit<QuickInput, "eventDate">[] = [
      { type: "expense", amount, fromAccountId: f.card.id, categoryId: f.category("餐饮") },
      { type: "income", amount, toAccountId: f.bank.id, categoryId: f.category("工资") },
      { type: "transfer", amount, fromAccountId: f.bank.id, toAccountId: f.wallet.id, toAmount: "6.70" },
      { type: "loan_out", amount, fromAccountId: f.card.id, toAccountId: f.receivable.id },
      { type: "refund", amount, toAccountId: f.card.id, categoryId: f.category("餐饮") },
    ];
    await quick(variants[random % variants.length]);
  }
  const balances = await balancesAsOf(harness.db, f.ownerId, date);
  for (const currency of ["USD", "CNY"]) {
    expect(
      sumMoney(balances.filter((row) => row.currency === currency).map((row) => row.balance)).toFixed(4),
    ).toBe("0.0000");
  }
}, 30000);
it("demo seed covers every type over 60 days, uses a separate owner, and is idempotent", async () => {
  const input = { email: "demo@example.com", password: "synthetic-demo-password", today: "2026-10-24" };
  const demo = await seedDemo(harness.db, input);
  const rewards = await rewardsOverview(harness.db, demo.ownerId, input.today);
  expect(rewards.accounts).toHaveLength(4);
  const reward = (code: string) => rewards.accounts.find((row) => row.program.code === code)!;
  expect(reward("MR").events.filter((row) => row.type === "earn")).toHaveLength(2);
  expect(reward("MR").points).toBe("33800");
  expect(reward("AA").observations).toHaveLength(1);
  expect(reward("AA").points).toBe("72000");
  expect(reward("UR").points).toBe("25000");
  expect(reward("HYATT").points).toBe("15000");
  expect(rewards.transfers).toHaveLength(1);
  expect(reward("MR").cppHistory.filter((row) => row.source === "user")).toHaveLength(1);
  const first = await harness.db
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.ownerId, demo.ownerId));
  const demoCard = (await listAccounts(harness.db, demo.ownerId)).find(
    (row) => row.name === "Demo Card 1234",
  )!;
  await harness.db.update(accounts).set({ last4: null }).where(eq(accounts.id, demoCard.id));
  await seedDemo(harness.db, input);
  await seedDemo(harness.db, { ...input, today: "2026-10-25" });
  expect(await rewardsOverview(harness.db, demo.ownerId, input.today)).toEqual(rewards);
  expect((await rewardsOverview(harness.db, f.ownerId, input.today)).accounts).toHaveLength(0);
  expect((await listAccounts(harness.db, demo.ownerId)).find((row) => row.id === demoCard.id)?.last4).toBe(
    "1234",
  );
  const second = await harness.db
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.ownerId, demo.ownerId));
  expect(second).toHaveLength(first.length);
  expect(new Set(first.map((entry) => entry.entryType)).size).toBe(14);
  expect(first.length).toBeGreaterThan(60);
  expect(
    await harness.db.select().from(journalEntries).where(eq(journalEntries.ownerId, f.ownerId)),
  ).toHaveLength(0);
  await expect(seedDemo(harness.db, { ...input, email: "ledger@example.com" })).rejects.toThrow("非演示用户");
  const audit = await harness.db.select().from(auditLogs).where(eq(auditLogs.ownerId, demo.ownerId));
  expect(JSON.stringify(audit)).not.toContain(input.password);
  expect(
    (
      await harness.db
        .select()
        .from(postings)
        .where(and(eq(postings.ownerId, demo.ownerId)))
    ).length,
  ).toBeGreaterThan(120);
}, 30000);
it("archiving a category preserves history and still permits merchant edits", async () => {
  const entry = await quick({
    type: "expense",
    amount: "30",
    fromAccountId: f.bank.id,
    categoryId: f.category("购物"),
  });
  await updateCategory(harness.db, f.ownerId, f.category("购物"), { isArchived: true });
  const line = entry.postings.find((row) => row.accountId === f.expense.id)!;
  await updateEntryMeta(harness.db, f.ownerId, entry.id, {
    merchant: "Example Updated Merchant",
    categories: [{ postingId: line.id, categoryId: line.categoryId! }],
  });
  expect((await getEntry(harness.db, f.ownerId, entry.id)).merchant).toBe("Example Updated Merchant");
  expect(await spending()).toBe("30.00");
  await expect(
    quick({ type: "expense", amount: "5", fromAccountId: f.bank.id, categoryId: f.category("购物") }),
  ).rejects.toThrow("归档");
});
it("advanced split expenses preserve category totals and reject illegal types and group links", async () => {
  const entry = await createEntry(harness.db, f.ownerId, {
    entryType: "expense",
    eventDate: date,
    postings: [
      { accountId: f.expense.id, amount: "30", currency: "USD", categoryId: f.category("餐饮") },
      { accountId: f.expense.id, amount: "70", currency: "USD", categoryId: f.category("购物") },
      { accountId: f.card.id, amount: "-100", currency: "USD" },
    ],
  });
  expect(await spending()).toBe("100.00");
  expect(entry.postings).toHaveLength(3);
  const group = await createPurchaseGroup(harness.db, f.ownerId, {
    title: "Synthetic CNY group",
    currency: "CNY",
    confirmedTotal: "100",
  });
  await expect(linkGroupEntry(harness.db, f.ownerId, group.id, entry.id)).rejects.toThrow("币种");
  await expect(
    quick({ type: "income", amount: "10", toAccountId: f.security.id, categoryId: f.category("工资") }),
  ).rejects.toThrow("账户或借贷方向");
  await expect(quick({ type: "balance_adjustment", amount: "10", toAccountId: f.bank.id })).rejects.toThrow(
    "原因",
  );
  await expect(
    quick({ type: "credit_card_payment", amount: "10", fromAccountId: f.card.id, toAccountId: f.bank.id }),
  ).rejects.toThrow("账户或借贷方向");
  await expect(
    quick({
      type: "expense",
      amount: "10",
      fromAccountId: f.card.id,
      categoryId: f.category("购物"),
      feeAmount: "1",
    }),
  ).rejects.toThrow("手续费");
});
