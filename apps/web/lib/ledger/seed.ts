import { seedDemoRewards } from "@/lib/rewards/seed";
import { loadDemoLedger } from "../../../../fixtures/demo/demo-ledger";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, auditLogs, journalEntries, users } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { createAdmin } from "@/lib/auth/admin";
import { auditLedger } from "./audit";
import { createAccount, listAccounts, createInstitution, listInstitutions } from "./accounts";
import { listCategories } from "./categories";
import { createQuickEntry } from "./builders";
import { createPurchaseGroup, listPurchaseGroups } from "./purchase-groups";
import { invariant } from "./errors";
import type { QuickInput } from "./schemas";
import type { AccountType } from "./constants";
export async function seedDemo(db: AppDb, input: { email: string; password: string; today: string }) {
  const email = z.email().parse(input.email.trim().toLowerCase());
  invariant(input.password.length >= 12, "演示密码至少 12 字符");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`demo:${email}`}))`);
    let [user] = await tx.select().from(users).where(eq(users.email, email));
    if (user) {
      const marker = await tx
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(and(eq(auditLogs.ownerId, user.id), eq(auditLogs.action, "demo.seed")))
        .limit(1);
      invariant(marker.length, "该邮箱属于非演示用户，请使用独立邮箱", 409);
    } else {
      const created = await createAdmin(tx, {
        email,
        password: input.password,
        baseCurrency: "USD",
        timezone: "America/Los_Angeles",
      });
      invariant(created, "演示用户创建失败");
      [user] = await tx.select().from(users).where(eq(users.id, created.id));
      await auditLedger(tx, user.id, "user", user.id, "demo.seed");
    }
    const ownerId = user.id;
    const existingInstitutions = await listInstitutions(tx, ownerId);
    const bank =
      existingInstitutions.find((row) => row.name === "Example Bank") ??
      (await createInstitution(tx, ownerId, { name: "Example Bank", kind: "bank" }));
    const existingAccounts = await listAccounts(tx, ownerId);
    const definitions: [string, AccountType, string][] = [
      ["Example Bank Checking", "asset_cash", "USD"],
      ["Demo Card 1234", "liability_credit_card", "USD"],
      ["Demo Brokerage Cash", "asset_brokerage_cash", "USD"],
      ["Demo Brokerage Securities", "asset_security", "USD"],
      ["Demo CNY Wallet", "asset_cash", "CNY"],
      ["Demo Receivable", "asset_receivable", "USD"],
      ["Demo Prepaid", "asset_prepaid", "USD"],
      ["Demo Loan", "liability_loan", "USD"],
    ];
    const demoAccounts = [];
    for (const [name, type, currency] of definitions) {
      demoAccounts.push(
        existingAccounts.find((row) => row.name === name) ??
          (await createAccount(tx, ownerId, {
            name,
            type,
            currency,
            institutionId: bank.id,
            last4: type === "liability_credit_card" ? "1234" : null,
          })),
      );
    }
    const [checking, card, brokerage, security, wallet, receivable, prepaid, loan] = demoAccounts;
    if (card.last4 !== "1234") {
      await tx
        .update(accounts)
        .set({ last4: "1234" })
        .where(and(eq(accounts.ownerId, ownerId), eq(accounts.id, card.id)));
    }
    const categories = await listCategories(tx, ownerId);
    const category = (name: string) => {
      const row = categories.find((item) => item.name === name && !item.isArchived);
      invariant(row, "演示分类已更改，请保留合成分类后重试");
      return row.id;
    };
    const day = (offset: number) => {
      const date = new Date(`${input.today}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() - 59 + offset);
      return date.toISOString().slice(0, 10);
    };
    const add = async (key: string, values: Omit<QuickInput, "eventDate"> & { offset?: number }) => {
      const reference = `demo-v1:${key}`;
      const [existing] = await tx
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.externalReference, reference)));
      if (existing) return existing;
      const { offset = 0, ...input } = values;
      const created = await createQuickEntry(tx, ownerId, {
        ...input,
        eventDate: day(offset),
        merchant: "Example Merchant",
      });
      await tx
        .update(journalEntries)
        .set({ externalReference: reference })
        .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, created.id)));
      return created;
    };
    for (const [account, amount] of [
      [checking, "7500"],
      [card, "-180"],
      [brokerage, "4500"],
      [security, "1200"],
      [wallet, "900"],
      [receivable, "300"],
      [prepaid, "600"],
      [loan, "-2500"],
    ] as const) {
      await add(`opening:${account.type}:${account.currency}`, {
        type: "opening_balance",
        toAccountId: account.id,
        amount,
      });
    }
    const purchases = ["18.50", "36.20", "12.80", "47.90", "24.10"];
    for (let offset = 0; offset < 60; offset++) {
      await add(`daily:${offset}`, {
        type: "expense",
        fromAccountId: card.id,
        amount: purchases[offset % purchases.length],
        categoryId: category(offset % 2 ? "餐饮" : "日用杂货"),
        offset,
      });
      if (offset % 15 === 0) {
        await add(`salary:${offset}`, {
          type: "income",
          toAccountId: checking.id,
          amount: "2450",
          categoryId: category("工资"),
          offset,
        });
        await add(`payment:${offset}`, {
          type: "credit_card_payment",
          fromAccountId: checking.id,
          toAccountId: card.id,
          amount: "460",
          offset,
        });
      }
    }
    await add("transfer", {
      type: "transfer",
      fromAccountId: checking.id,
      toAccountId: brokerage.id,
      amount: "650",
      offset: 5,
    });
    await add("fx-transfer", {
      type: "transfer",
      fromAccountId: checking.id,
      toAccountId: wallet.id,
      amount: "100",
      toAmount: "670",
      offset: 6,
    });
    await add("buy", {
      type: "investment_buy",
      fromAccountId: brokerage.id,
      toAccountId: security.id,
      amount: "850",
      feeAmount: "2.50",
      feeCategoryId: category("手续费"),
      offset: 8,
    });
    await add("sell", {
      type: "investment_sell",
      fromAccountId: security.id,
      toAccountId: brokerage.id,
      amount: "320",
      offset: 20,
    });
    await add("loan", {
      type: "loan_out",
      fromAccountId: checking.id,
      toAccountId: receivable.id,
      amount: "125",
      offset: 10,
    });
    await add("repayment", {
      type: "loan_repayment",
      fromAccountId: receivable.id,
      toAccountId: checking.id,
      amount: "75",
      offset: 25,
    });
    await add("prepaid", {
      type: "prepayment",
      fromAccountId: checking.id,
      toAccountId: prepaid.id,
      amount: "450",
      offset: 15,
    });
    await add("amortization", {
      type: "expense",
      fromAccountId: prepaid.id,
      amount: "450",
      categoryId: category("住房租金"),
      offset: 30,
    });
    await add("fee", {
      type: "fee",
      fromAccountId: card.id,
      amount: "9.95",
      categoryId: category("手续费"),
      offset: 32,
    });
    await add("interest", {
      type: "interest",
      interestDirection: "income",
      toAccountId: checking.id,
      amount: "4.25",
      categoryId: category("利息收入"),
      offset: 35,
    });
    await add("adjustment", {
      type: "balance_adjustment",
      toAccountId: checking.id,
      amount: "-1.25",
      notes: "合成余额核对调整",
      offset: 42,
    });
    const original = await add("refundable", {
      type: "expense",
      fromAccountId: card.id,
      amount: "68",
      categoryId: category("购物"),
      offset: 43,
    });
    await add("refund", {
      type: "refund",
      toAccountId: card.id,
      amount: "18",
      categoryId: category("购物"),
      refundOfEntryId: original.id,
      offset: 46,
    });
    await add("draft", {
      type: "expense",
      fromAccountId: checking.id,
      amount: "22.50",
      categoryId: category("交通"),
      status: "draft",
      offset: 59,
    });
    const group =
      (await listPurchaseGroups(tx, ownerId)).find((row) => row.title === "Demo Home Office") ??
      (await createPurchaseGroup(tx, ownerId, {
        title: "Demo Home Office",
        confirmedTotal: "840",
        currency: "USD",
        categoryId: category("电子产品"),
      }));
    await add("group-card", {
      type: "expense",
      fromAccountId: card.id,
      amount: "340",
      categoryId: category("电子产品"),
      purchaseGroupId: group.id,
      offset: 50,
    });
    await add("group-bank", {
      type: "expense",
      fromAccountId: checking.id,
      amount: "500",
      categoryId: category("电子产品"),
      purchaseGroupId: group.id,
      offset: 51,
    });
    await loadDemoLedger(tx, ownerId);
    await seedDemoRewards(tx, ownerId, input.today);
    return { ownerId };
  });
}
