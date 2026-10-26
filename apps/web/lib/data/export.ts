import { eq, getTableColumns } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import { users } from "@/db/schema";
import { invariant } from "@/lib/ledger/errors";
import { jsonSafe } from "@/lib/serialization";
import { ownerTables, exportTableNames } from "./tables";
async function profile(db: AppDb, ownerId: string) {
  return db
    .select({
      id: users.id,
      email: users.email,
      baseCurrency: users.baseCurrency,
      timezone: users.timezone,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.id, ownerId));
}
function exportColumns(table: (typeof ownerTables)[keyof typeof ownerTables]) {
  // Encrypted provider tokens are credentials too: exclude at SELECT time in JSON and CSV.
  return Object.fromEntries(
    Object.entries(getTableColumns(table)).filter(
      ([name]) => name !== "accessTokenEnc" && name !== "transactionsCursor" && name !== "secretEnc",
    ),
  );
}
export async function exportOwnerData(db: AppDb, ownerId: string) {
  return db.transaction(
    async (tx) => {
      const data: Record<string, unknown> = { profile: await profile(tx, ownerId) };
      for (const [name, table] of Object.entries(ownerTables))
        data[name] = await tx.select(exportColumns(table)).from(table).where(eq(table.ownerId, ownerId));
      return jsonSafe({ formatVersion: 1, exportedAt: new Date().toISOString(), tables: data });
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
function csvCell(value: unknown) {
  let text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(jsonSafe(value))
        : String(value);
  // Spreadsheet formula injection protection; signed decimal amounts remain numeric.
  if (/^[\s]*[=+@-]/.test(text) && !/^-?\d+(?:\.\d+)?$/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export async function exportOwnerCsv(db: AppDb, ownerId: string, name: string) {
  invariant(exportTableNames.includes(name), "请选择可导出的数据表");
  const table = ownerTables[name as keyof typeof ownerTables];
  const raw =
    name === "profile"
      ? await profile(db, ownerId)
      : await db.select(exportColumns(table)).from(table).where(eq(table.ownerId, ownerId));
  const rows = jsonSafe(raw) as Record<string, unknown>[];
  const columns =
    name === "profile"
      ? ["id", "email", "baseCurrency", "timezone", "createdAt", "updatedAt"]
      : Object.keys(exportColumns(table));
  return (
    "\uFEFF" +
    [
      columns.map(csvCell).join(","),
      ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
    ].join("\r\n") +
    "\r\n"
  );
}
