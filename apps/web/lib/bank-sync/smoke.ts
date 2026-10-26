import { setTimeout as sleep } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { money } from "@/lib/money";
import { createAccount, listAccounts } from "@/lib/ledger/accounts";
import { listCategories } from "@/lib/ledger/categories";
import { invariant } from "@/lib/ledger/errors";
import { createSandboxPublicToken, PlaidClient } from "./plaid-client";
import { collectSync, syncConnection, signedPlaidAmount } from "./sync";
import { exchangeConnection, saveMapping } from "./connections";
import type { PlaidConfig } from "./types";
export async function sandboxSmoke(config: PlaidConfig, ownerEmail?: string) {
  invariant(config.PLAID_ENV === "sandbox", "仅允许 Sandbox；未发出任何请求");
  const abort = new AbortController();
  const client = new PlaidClient(config, abort.signal);
  // Check the optional local owner before creating any Item.
  const db = ownerEmail ? getDb() : null;
  const [owner] =
    db && ownerEmail ? await db.select().from(users).where(eq(users.email, ownerEmail.toLowerCase())) : [];
  invariant(!ownerEmail || owner, "导入用户不存在");
  const publicToken = await createSandboxPublicToken(config);
  let accessToken: string | null = null;
  let connectionId: string | null = null;
  const deadline = Date.now() + 90000;
  const cancellation = setTimeout(() => abort.abort(), 90000);
  const bounded = async <T>(operation: Promise<T>) => {
    const remaining = deadline - Date.now();
    invariant(remaining > 0, "sandbox_poll_timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("sandbox_poll_timeout")), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    if (db && owner) {
      const created = await bounded(
        exchangeConnection(db, owner.id, client, config, {
          public_token: publicToken,
          institution: { institution_id: "ins_109508", name: "First Platypus Bank (Sandbox)" },
        }),
      );
      connectionId = created.connection.id;
      const ledger = await listAccounts(db, owner.id);
      const mapping = [];
      for (const row of created.accounts) {
        if (!row.currency || !["depository", "credit"].includes(row.type)) {
          mapping.push({ id: row.id, accountId: null, securityAccountId: null, isEnabled: false });
          continue;
        }
        const type = row.type === "credit" ? "liability_credit_card" : "asset_cash";
        const name = `Plaid Sandbox ${created.connection.id.slice(0, 8)} ${row.name}`.slice(0, 100);
        const account =
          ledger.find((account) => account.name === name) ??
          (await createAccount(db, owner.id, {
            name,
            type,
            currency: row.currency,
            last4: row.mask && /^\d{4}$/.test(row.mask) ? row.mask : null,
          }));
        mapping.push({ id: row.id, accountId: account.id, securityAccountId: null, isEnabled: true });
      }
      await listCategories(db, owner.id);
      await saveMapping(db, owner.id, connectionId, config, {
        importFromDate: created.connection.importFromDate,
        accounts: mapping,
      });
      const { requireConnection, token } = await import("./connections");
      accessToken = token(await requireConnection(db, owner.id, connectionId), config);
    } else accessToken = (await bounded(client.exchange(publicToken))).accessToken;
    await bounded(client.refresh(accessToken));
    for (;;) {
      const batch = await bounded(collectSync(client, accessToken, null));
      if (batch) {
        const counts: Record<string, number> = {};
        for (const account of batch.accounts) counts[account.type] = (counts[account.type] ?? 0) + 1;
        const posted = batch.added.filter((row) => !row.pending);
        const signChecked = posted.filter((row) => {
          const signed = money(signedPlaidAmount(row.amount));
          return money(row.amount).gt(0)
            ? signed.lt(0)
            : money(row.amount).lt(0)
              ? signed.gt(0)
              : signed.isZero();
        }).length;
        if (db && owner && connectionId)
          await bounded(syncConnection(db, owner.id, connectionId, client, config));
        console.log(
          JSON.stringify({
            accountsByType: counts,
            added: batch.added.length,
            modified: batch.modified.length,
            removed: batch.removed.length,
            pendingSkipped: batch.added.filter((row) => row.pending).length,
            signChecked,
            signFailures: posted.length - signChecked,
          }),
        );
        return;
      }
      invariant(Date.now() + 2000 < deadline, "sandbox_poll_timeout");
      await sleep(2000);
    }
  } finally {
    // --import retains a managed Sandbox Item; the no-import smoke cleans up its temporary Item.
    clearTimeout(cancellation);
    abort.abort();
    if (accessToken && !connectionId) await new PlaidClient(config).remove(accessToken);
  }
}
