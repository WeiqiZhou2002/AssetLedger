import type { AppDb } from "@/db/types";
import { users } from "@/db/schema";
import { createAccount, getSystemAccount } from "@/lib/ledger/accounts";
import { listCategories } from "@/lib/ledger/categories";
export async function ledgerFixture(db: AppDb) {
  const [user, other] = await db
    .insert(users)
    .values([
      { email: "ledger@example.com", passwordHash: "synthetic-not-a-login-hash" },
      { email: "other@example.com", passwordHash: "synthetic-not-a-login-hash" },
    ])
    .returning();
  const ownerId = user.id;
  const account = (name: string, type: Parameters<typeof createAccount>[2], currency = "USD") =>
    createAccount(db, ownerId, { name, type, currency });
  const bank = await account("Example Bank Checking", "asset_cash");
  const card = await account("Demo Card 1234", "liability_credit_card");
  const broker = await account("Demo Brokerage Cash", "asset_brokerage_cash");
  const security = await account("Demo Securities", "asset_security");
  const receivable = await account("Demo Receivable", "asset_receivable");
  const prepaid = await account("Demo Prepaid", "asset_prepaid");
  const wallet = await account("Demo CNY Wallet", "asset_cash", "CNY");
  const categories = await listCategories(db, ownerId);
  const category = (name: string) => categories.find((row) => row.name === name)!.id;
  const expense = await getSystemAccount(db, ownerId, "expense", "USD");
  const income = await getSystemAccount(db, ownerId, "income", "USD");
  return {
    ownerId,
    otherId: other.id,
    bank,
    card,
    broker,
    security,
    receivable,
    prepaid,
    wallet,
    categories,
    category,
    expense,
    income,
  };
}
