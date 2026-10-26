import { and, eq } from "drizzle-orm";
import { accounts, journalEntries, postings, purchaseGroups } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { invariant } from "./errors";
import type { ValidEntry } from "./schemas";
export async function validateGroupLink(
  db: AppDb,
  ownerId: string,
  groupId: string,
  entry: Pick<ValidEntry, "entryType" | "postings">,
) {
  const [group] = await db
    .select()
    .from(purchaseGroups)
    .where(and(eq(purchaseGroups.ownerId, ownerId), eq(purchaseGroups.id, groupId)))
    .for("share");
  invariant(group, "购物组不存在", 404);
  invariant(
    ["expense", "refund", "fee", "interest"].includes(entry.entryType),
    "购物组只能关联消费、退款或支出费用",
  );
  invariant(
    entry.postings.every((line) => line.currency === group.currency),
    "购物组和流水币种必须一致",
  );
  const expenseAccounts = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.ownerId, ownerId), eq(accounts.type, "expense")));
  invariant(
    entry.postings.some((line) => expenseAccounts.some((account) => account.id === line.accountId)),
    "购物组只能关联包含支出的流水",
  );
}
export async function validateRefundLink(db: AppDb, ownerId: string, entry: ValidEntry) {
  if (!entry.refundOfEntryId) {
    return;
  }
  const [original] = await db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.ownerId, ownerId), eq(journalEntries.id, entry.refundOfEntryId)))
    .for("share");
  invariant(original && original.status === "confirmed", "退款原流水不存在或未确认", 404);
  const expenses = await db
    .select({ amount: postings.amount, currency: postings.currency })
    .from(postings)
    .innerJoin(accounts, and(eq(accounts.id, postings.accountId), eq(accounts.ownerId, ownerId)))
    .where(
      and(
        eq(postings.ownerId, ownerId),
        eq(postings.journalEntryId, original.id),
        eq(accounts.type, "expense"),
      ),
    );
  invariant(
    expenses.some((line) => !line.amount.startsWith("-") && line.currency === entry.postings[0].currency),
    "原流水没有同币种消费",
  );
}
