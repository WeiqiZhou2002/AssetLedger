import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "./helpers/db";

it("upgrades all owners, deletes only retired data, detaches points, preserves Plaid versions and all other tables, and backfills manual reminders", async () => {
  const h = await createTestDb(17);
  try {
    // Raw inserts target the pre-upgrade schema, which has no reminder column yet.
    const insert = async (table: string, values: Record<string, unknown>) => {
      const id = randomUUID();
      const data = { id, ...values };
      await h.client.query(
        `INSERT INTO "${table}" (${Object.keys(data)
          .map((key) => `"${key}"`)
          .join(",")}) VALUES (${Object.keys(data)
          .map((_, i) => `$${i + 1}`)
          .join(",")})`,
        Object.values(data),
      );
      return id;
    };
    const manual: string[] = [],
      nonmanual: string[] = [],
      plaidIds: string[] = [];
    for (let index = 0; index < 2; index++) {
      const owner = await insert("users", {
        email: `synthetic-migration-${index}@example.com`,
        password_hash: "synthetic",
      });
      const account = (name: string, extra = {}) =>
        insert("accounts", { owner_id: owner, name, type: "asset_cash", currency: "USD", ...extra });
      const cash = await account("Example Bank");
      manual.push(cash);
      const card = await account("Demo Card 1234", { type: "liability_credit_card" });
      manual.push(card);
      const disabled = await account("Inactive", { is_active: false });
      nonmanual.push(disabled);
      const nominal = await account("Expense", { type: "expense", is_system: true });
      nonmanual.push(nominal);
      const synced = await account("Plaid Cash");
      nonmanual.push(synced);
      const security = await account("Plaid Securities", { type: "asset_security" });
      nonmanual.push(security);
      const mappingOff = await account("Disabled mapping");
      manual.push(mappingOff);
      const connection = await insert("bank_connections", {
        owner_id: owner,
        environment: "sandbox",
        plaid_item_id: `synthetic-item-${index}`,
        institution_name: "Example Bank",
        access_token_enc: "synthetic",
        import_from_date: "2026-10-01",
      });
      for (const [id, enabled, securities] of [
        [synced, true, security],
        [mappingOff, false, null],
      ] as const) {
        await insert("bank_connection_accounts", {
          owner_id: owner,
          connection_id: connection,
          plaid_account_id: id,
          name: "Synthetic",
          type: "investment",
          currency: "USD",
          account_id: id,
          security_account_id: securities,
          is_enabled: enabled,
        });
      }
      const legacy = await insert("legacy_imports", {
        owner_id: owner,
        file_sha256: String(index).repeat(64),
        filename: "synthetic.xlsx",
        sheet_count: 1,
      });
      await insert("legacy_mappings", { owner_id: owner, layout_signature: "synthetic", mapping: {} });
      const snapshots: string[] = [];
      for (const source of ["manual", "legacy_xlsx", "statement", "plaid"] as const) {
        for (const status of ["draft", "published"] as const) {
          const id = await insert("balance_snapshots", {
            owner_id: owner,
            source,
            status,
            label: "Synthetic observation",
            snapshot_date: status === "draft" ? "2026-10-01" : "2026-10-02",
            base_currency: "USD",
            ...(source === "legacy_xlsx" ? { legacy_import_id: legacy, legacy_sheet_name: status } : {}),
          });
          snapshots.push(id);
          if (source === "plaid") plaidIds.push(id);
          for (const version of [1, 2])
            await insert("snapshot_items", {
              owner_id: owner,
              snapshot_id: id,
              account_id: cash,
              balance_native: "12.3456",
              currency: "USD",
              version,
              is_current: version === 2,
            });
          await insert("snapshot_fx", {
            owner_id: owner,
            snapshot_id: id,
            quote_currency: "CNY",
            rate: "6.7",
            observed_on: "2026-09-30",
            source: "synthetic",
          });
        }
      }
      await insert("reconciliation_runs", {
        owner_id: owner,
        from_snapshot_id: snapshots[0],
        to_snapshot_id: snapshots[1],
        scope: "cash_like",
        engine_version: "synthetic",
        result: {},
      });
      await insert("reconciliation_notes", {
        owner_id: owner,
        from_snapshot_id: snapshots[6],
        to_snapshot_id: snapshots[7],
        title: "Synthetic",
        body: "Synthetic",
      });
      const valuation = await insert("legacy_points_valuations", {
        owner_id: owner,
        snapshot_id: snapshots[2],
        program_label: "Demo Points",
        value_usd: "100",
      });
      const program = await insert("loyalty_programs", {
        owner_id: owner,
        code: "DEMO",
        name: "Demo Points",
        kind: "bank_points",
        unit_label: "点",
      });
      const loyalty = await insert("loyalty_accounts", {
        owner_id: owner,
        program_id: program,
        name: "Demo Points",
      });
      await insert("loyalty_observations", {
        owner_id: owner,
        loyalty_account_id: loyalty,
        observed_on: "2026-10-01",
        balance: "9007199254740993",
        source: "legacy",
        legacy_valuation_id: valuation,
      });
      const entry = await insert("journal_entries", {
        owner_id: owner,
        entry_type: "expense",
        status: "confirmed",
        event_date: "2026-10-02",
        source: "manual",
      });
      for (const [id, amount] of [
        [cash, "-10"],
        [nominal, "10"],
      ])
        await insert("postings", {
          owner_id: owner,
          journal_entry_id: entry,
          account_id: id,
          amount,
          currency: "USD",
        });
    }
    const tables = (
      await h.client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      )
    ).rows.map((row) => row.table_name);
    const before = new Map<string, unknown[]>();
    for (const table of tables)
      before.set(table, (await h.client.query(`SELECT * FROM "${table}" ORDER BY id`)).rows);
    await h.applyMigrations();
    const erased = [
      "reconciliation_notes",
      "reconciliation_runs",
      "legacy_points_valuations",
      "legacy_mappings",
      "legacy_imports",
    ];
    const special = new Set([
      ...erased,
      "accounts",
      "balance_snapshots",
      "snapshot_items",
      "snapshot_fx",
      "loyalty_observations",
    ]);
    for (const table of tables) {
      if (erased.includes(table)) {
        expect((await h.client.query("SELECT to_regclass($1) AS name", [table])).rows).toEqual([
          { name: null },
        ]);
        continue;
      }
      const after = (await h.client.query(`SELECT * FROM "${table}" ORDER BY id`)).rows;
      if (!special.has(table)) expect(after, table).toEqual(before.get(table));
    }
    for (const table of ["balance_snapshots", "snapshot_items", "snapshot_fx"]) {
      const kept = (before.get(table) as Record<string, unknown>[]).filter((row) =>
        plaidIds.includes(String(table === "balance_snapshots" ? row.id : row.snapshot_id)),
      );
      const expected =
        table === "balance_snapshots"
          ? kept.map((row) =>
              Object.fromEntries(
                Object.entries(row).filter(
                  ([key]) => !["legacy_import_id", "legacy_sheet_name"].includes(key),
                ),
              ),
            )
          : kept;
      expect((await h.client.query(`SELECT * FROM "${table}" ORDER BY id`)).rows).toEqual(expected);
    }
    expect((await h.client.query('SELECT * FROM "loyalty_observations" ORDER BY id')).rows).toEqual(
      (before.get("loyalty_observations") as Record<string, unknown>[]).map((row) =>
        Object.fromEntries(Object.entries(row).filter(([key]) => key !== "legacy_valuation_id")),
      ),
    );
    const upgraded = await h.db.select().from(schema.accounts);
    for (const row of upgraded) expect(row.balanceReminderDays).toBe(manual.includes(row.id) ? 7 : null);
    expect(upgraded.filter((row) => nonmanual.includes(row.id))).toHaveLength(nonmanual.length);
    const [newAccount] = await h.db
      .insert(schema.accounts)
      .values({ ownerId: upgraded[0].ownerId, name: "New manual", type: "asset_cash", currency: "USD" })
      .returning();
    expect(newAccount.balanceReminderDays).toBe(7);
    // Running migrations again must not delete new manual observations.
    const [newObservation] = await h.db
      .insert(schema.balanceSnapshots)
      .values({
        ownerId: newAccount.ownerId,
        snapshotDate: "2026-10-25",
        label: "New update",
        source: "manual",
        baseCurrency: "USD",
      })
      .returning();
    await h.applyMigrations();
    expect(
      await h.db
        .select()
        .from(schema.balanceSnapshots)
        .where(eq(schema.balanceSnapshots.id, newObservation.id)),
    ).toHaveLength(1);
  } finally {
    await h.client.close();
  }
});
