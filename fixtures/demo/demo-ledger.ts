import type { AppDb } from "../../apps/web/db/types";
import { createAccount, listAccounts } from "../../apps/web/lib/ledger/accounts";
import { createQuickEntry } from "../../apps/web/lib/ledger/builders";
import { listCategories } from "../../apps/web/lib/ledger/categories";
import {
  fixtureEntry,
  fixtureSnapshot,
  publishFixtureObservation,
  tagFixtureEntry,
} from "../../apps/web/lib/ledger/fixture-support";
import { accountBalance } from "../../apps/web/lib/ledger/queries";
import type { QuickInput } from "../../apps/web/lib/ledger/schemas";
import { lockOwnerStructure } from "../../apps/web/lib/snapshots/groups";
import { getSnapshot } from "../../apps/web/lib/snapshots/service";

// Arbitrary synthetic journal inputs. Observations are derived through the ledger engine;
// expected business totals belong only in tests.
export async function loadDemoLedger(db: AppDb, ownerId: string) {
  return db.transaction(async (tx) => {
    await lockOwnerStructure(tx, ownerId);
    const existing = await listAccounts(tx, ownerId);
    const definitions = [
      { name: "Example Bank Demo Checking", type: "asset_cash" },
      { name: "Demo Card 5678", type: "liability_credit_card", last4: "5678" },
      { name: "Example Brokerage Demo Cash", type: "asset_brokerage_cash" },
    ] as const;
    const accounts = [];
    for (const values of definitions)
      accounts.push(
        existing.find((row) => row.name === values.name) ??
          (await createAccount(tx, ownerId, { ...values, currency: "USD" })),
      );
    const [checking, card, brokerage] = accounts;
    const categories = await listCategories(tx, ownerId);
    const category = (name: string) => categories.find((row) => row.name === name)!.id;
    const add = async (key: string, values: QuickInput) => {
      const reference = `demo-ledger-v1:${key}`;
      const prior = await fixtureEntry(tx, ownerId, reference);
      if (prior) return prior;
      const entry = await createQuickEntry(tx, ownerId, values);
      await tagFixtureEntry(tx, ownerId, entry.id, reference);
      return entry;
    };
    await add("income", {
      type: "income",
      toAccountId: checking.id,
      amount: "1375",
      categoryId: category("工资"),
      eventDate: "2026-10-01",
      merchant: "Example Employer",
    });
    const purchase = await add("purchase", {
      type: "expense",
      fromAccountId: card.id,
      amount: "86.25",
      categoryId: category("购物"),
      eventDate: "2026-10-04",
      merchant: "Example Shop",
    });
    await add("transfer", {
      type: "transfer",
      fromAccountId: checking.id,
      toAccountId: brokerage.id,
      amount: "275",
      eventDate: "2026-10-10",
    });
    await add("refund", {
      type: "refund",
      toAccountId: card.id,
      amount: "16.25",
      categoryId: category("购物"),
      refundOfEntryId: purchase.id,
      eventDate: "2026-10-15",
      merchant: "Example Shop",
    });
    await add("payment", {
      type: "credit_card_payment",
      fromAccountId: checking.id,
      toAccountId: card.id,
      amount: "50",
      eventDate: "2026-10-20",
    });
    await add("groceries", {
      type: "expense",
      fromAccountId: checking.id,
      amount: "23.40",
      categoryId: category("日用杂货"),
      eventDate: "2026-10-23",
      merchant: "Example Market",
    });
    const date = "2026-10-24";
    const label = "Synthetic Demo Ledger";
    const prior = await fixtureSnapshot(tx, ownerId, label);
    if (prior) return { accounts, observation: await getSnapshot(tx, ownerId, prior.id) };
    const items = await Promise.all(
      accounts.map(async (account) => ({
        accountId: account.id,
        currency: account.currency,
        balanceNative: await accountBalance(tx, ownerId, account.id, date),
        sourceRef: `plaid:demo:${account.id}:${date}T12:00:00Z`,
      })),
    );
    const observation = await publishFixtureObservation(tx, ownerId, { snapshotDate: date, label, items });
    return { accounts, observation };
  });
}
