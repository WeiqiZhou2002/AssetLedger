import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";
config({ path: "../../.env", quiet: true });
export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgresql://localhost/asset_ledger" },
});
