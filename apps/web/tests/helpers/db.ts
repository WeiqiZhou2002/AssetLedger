import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
export async function createTestDb(beforeMigration?: number) {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const applyMigrations = () => migrate(db, { migrationsFolder: "./db/migrations" });
  if (beforeMigration === undefined) await applyMigrations();
  else {
    const folder = await mkdtemp(join(tmpdir(), "synthetic-migrations-"));
    try {
      await mkdir(join(folder, "meta"));
      const journal = JSON.parse(await readFile("./db/migrations/meta/_journal.json", "utf8")) as {
        entries: { idx: number; tag: string }[];
      };
      journal.entries = journal.entries.filter((entry) => entry.idx < beforeMigration);
      await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(journal));
      for (const entry of journal.entries)
        await copyFile(`./db/migrations/${entry.tag}.sql`, join(folder, `${entry.tag}.sql`));
      await migrate(db, { migrationsFolder: folder });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
  return { client, db, applyMigrations };
}
