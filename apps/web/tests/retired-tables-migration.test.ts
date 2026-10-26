import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createTestDb } from "./helpers/db";

const retiredTables = [
  "reconciliation_runs",
  "reconciliation_notes",
  "legacy_imports",
  "legacy_mappings",
  "legacy_points_valuations",
] as const;
const retiredColumns = ["legacy_valuation_id", "legacy_import_id", "legacy_sheet_name"];
type Harness = Awaited<ReturnType<typeof createTestDb>>;

async function insert(h: Harness, table: string, values: Record<string, unknown>) {
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
}

async function observe(h: Harness, ownerId: string, source = "plaid") {
  const accountId = await insert(h, "accounts", {
    owner_id: ownerId,
    name: "Example Bank",
    type: "asset_cash",
    currency: "USD",
  });
  const snapshotId = await insert(h, "balance_snapshots", {
    owner_id: ownerId,
    snapshot_date: "2026-10-24",
    label: "Synthetic observation",
    source,
    status: "published",
    base_currency: "USD",
  });
  for (const version of [1, 2])
    await insert(h, "snapshot_items", {
      owner_id: ownerId,
      snapshot_id: snapshotId,
      account_id: accountId,
      balance_native: "85.1250",
      currency: "USD",
      version,
      is_current: version === 2,
    });
  await insert(h, "snapshot_fx", {
    owner_id: ownerId,
    snapshot_id: snapshotId,
    quote_currency: "CNY",
    rate: "7.1",
    observed_on: "2026-10-24",
    source: "Synthetic",
  });
  const programId = await insert(h, "loyalty_programs", {
    owner_id: ownerId,
    code: "DEMO",
    name: "Demo Points",
    kind: "bank_points",
    unit_label: "点",
  });
  const loyaltyId = await insert(h, "loyalty_accounts", {
    owner_id: ownerId,
    program_id: programId,
    name: "Demo Points",
  });
  const observationId = await insert(h, "loyalty_observations", {
    owner_id: ownerId,
    loyalty_account_id: loyaltyId,
    observed_on: "2026-10-24",
    balance: "9007199254740993",
    source: "legacy",
  });
  return { snapshotId, observationId };
}

async function dump(h: Harness) {
  const tables = (
    await h.client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    )
  ).rows;
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const { table_name: table } of tables)
    result[table] = (
      await h.client.query<Record<string, unknown>>(`SELECT * FROM "${table}" ORDER BY id`)
    ).rows;
  return result;
}

it("retires empty tables and null columns while preserving all other data for every owner", async () => {
  const h = await createTestDb(21);
  try {
    for (const source of ["plaid", "manual"]) {
      const owner = await insert(h, "users", { email: `${source}@example.com`, password_hash: "synthetic" });
      await observe(h, owner, source);
    }
    const before = await dump(h);
    for (const table of retiredTables) delete before[table];
    for (const table of ["balance_snapshots", "loyalty_observations"])
      before[table] = before[table].map((row) =>
        Object.fromEntries(Object.entries(row).filter(([key]) => !retiredColumns.includes(key))),
      );
    await h.applyMigrations();
    expect(await dump(h)).toEqual(before);
    await h.applyMigrations();
    expect(await dump(h)).toEqual(before);
    const remaining = await h.client.query<{ typname: string }>(
      "SELECT typname FROM pg_type WHERE typname IN ('reconciliation_scope', 'review_status', 'legacy_status')",
    );
    expect(remaining.rows).toEqual([]);
  } finally {
    await h.client.close();
  }
});

it.each([...retiredTables, ...retiredColumns])(
  "rejects nonempty %s without losing data or recording the migration",
  async (target) => {
    const h = await createTestDb(21);
    try {
      const ownerId = await insert(h, "users", { email: "guard@example.com", password_hash: "synthetic" });
      const { snapshotId, observationId } = await observe(h, ownerId);
      const owned = { owner_id: ownerId };
      if (target === "reconciliation_runs")
        await insert(h, target, {
          ...owned,
          from_snapshot_id: snapshotId,
          to_snapshot_id: snapshotId,
          scope: "cash_like",
          engine_version: "synthetic",
          result: {},
        });
      else if (target === "reconciliation_notes")
        await insert(h, target, {
          ...owned,
          from_snapshot_id: snapshotId,
          to_snapshot_id: snapshotId,
          title: "Synthetic",
          body: "Synthetic",
        });
      else if (target === "legacy_imports")
        await insert(h, target, {
          ...owned,
          file_sha256: "a".repeat(64),
          filename: "synthetic.xlsx",
          sheet_count: 1,
        });
      else if (target === "legacy_mappings")
        await insert(h, target, { ...owned, layout_signature: "synthetic", mapping: {} });
      else if (target === "legacy_points_valuations")
        await insert(h, target, {
          ...owned,
          snapshot_id: snapshotId,
          program_label: "Demo Points",
          value_usd: "85",
        });
      else {
        // Isolate each column guard from its parent-table guard using a synthetic orphan.
        // Production foreign keys normally prevent these orphaned UUIDs.
        const table = target === "legacy_valuation_id" ? "loyalty_observations" : "balance_snapshots";
        const id = target === "legacy_valuation_id" ? observationId : snapshotId;
        if (target !== "legacy_sheet_name") {
          const parent = target === "legacy_valuation_id" ? "legacy_points_valuations" : "legacy_imports";
          await h.client.exec(
            `ALTER TABLE "${table}" DROP CONSTRAINT "${table}_owner_id_${target}_${parent}_owner_id_id_fk"`,
          );
        }
        await h.client.query(`UPDATE "${table}" SET "${target}" = $1 WHERE id = $2`, [
          target === "legacy_sheet_name" ? "Synthetic sheet" : randomUUID(),
          id,
        ]);
      }
      const before = await dump(h);
      const journal = (await h.client.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")).rows;
      const location =
        target === "legacy_valuation_id"
          ? `loyalty_observations.${target}`
          : retiredColumns.includes(target)
            ? `balance_snapshots.${target}`
            : target;
      await expect(h.applyMigrations()).rejects.toMatchObject({
        cause: {
          message: `Retired data guard: ${location} is ${retiredColumns.includes(target) ? "not null" : "not empty"}`,
        },
      });
      expect(await dump(h)).toEqual(before);
      expect((await h.client.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")).rows).toEqual(
        journal,
      );
    } finally {
      await h.client.close();
    }
  },
);
