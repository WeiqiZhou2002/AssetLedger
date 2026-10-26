import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { and, eq, lte } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import { bankResetExports } from "@/db/schema";
import { jsonSafe } from "@/lib/serialization";
import { invariant } from "@/lib/ledger/errors";
import type { ResetConfig } from "./reset-types";

export function resetFile(dataDir: string, ownerId: string, storagePath: string) {
  const directory = resolve(dataDir, "resets", ownerId);
  const path = resolve(dataDir, storagePath);
  invariant(
    /^[a-f0-9-]{36}$/i.test(ownerId) &&
      storagePath.startsWith(`resets/${ownerId}/`) &&
      path.startsWith(directory + "/") &&
      path.endsWith(".json"),
    "恢复导出路径无效",
    404,
  );
  return path;
}

export async function writeResetRecovery(
  config: Pick<ResetConfig, "DATA_DIR">,
  ownerId: string,
  payload: unknown,
  now: Date,
) {
  const id = randomUUID();
  const storagePath = join("resets", ownerId, `${now.toISOString().replaceAll(":", "-")}-${id}.json`);
  const path = resetFile(config.DATA_DIR, ownerId, storagePath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(jsonSafe(payload)), "utf8");
    await file.sync();
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  } finally {
    await file.close();
  }
  return { id, storagePath, path };
}
export async function listResetExports(db: AppDb, ownerId: string, now = new Date()) {
  const rows = await db
    .select({
      id: bankResetExports.id,
      createdAt: bankResetExports.createdAt,
      expiresAt: bankResetExports.expiresAt,
      counts: bankResetExports.counts,
      storagePath: bankResetExports.storagePath,
    })
    .from(bankResetExports)
    .where(eq(bankResetExports.ownerId, ownerId));
  return rows
    .filter((row) => row.storagePath && row.expiresAt > now)
    .map(({ id, createdAt, expiresAt, counts }) => ({
      id,
      createdAt,
      expiresAt,
      counts,
      downloadUrl: `/api/plaid/resets/${id}/recovery`,
    }));
}
export async function readResetRecovery(
  db: AppDb,
  ownerId: string,
  id: string,
  config: Pick<ResetConfig, "DATA_DIR">,
  now = new Date(),
) {
  const [record] = await db
    .select()
    .from(bankResetExports)
    .where(and(eq(bankResetExports.ownerId, ownerId), eq(bankResetExports.id, id)));
  invariant(record?.storagePath && record.expiresAt > now, "恢复导出不存在或已过保留期", 404);
  invariant(record.storagePath.startsWith(`resets/${ownerId}/`), "恢复导出路径无效", 404);
  return new Uint8Array(await readFile(resetFile(config.DATA_DIR, ownerId, record.storagePath)));
}
export async function retainResetExports(db: AppDb, config: Pick<ResetConfig, "DATA_DIR">, now = new Date()) {
  // Internal maintenance inventories owners; each mutation remains scoped to the record's owner.
  const due = await db.select().from(bankResetExports).where(lte(bankResetExports.expiresAt, now));
  for (const row of due) {
    if (!row.storagePath) continue;
    await rm(resetFile(config.DATA_DIR, row.ownerId, row.storagePath), { force: true });
    await db
      .update(bankResetExports)
      .set({ storagePath: null })
      .where(and(eq(bankResetExports.ownerId, row.ownerId), eq(bankResetExports.id, row.id)));
  }
}
