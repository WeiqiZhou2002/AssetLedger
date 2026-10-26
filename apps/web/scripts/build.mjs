import { build } from "esbuild";
import { mkdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const externals = ["pg", "@node-rs/argon2"];
await build({
  entryPoints: {
    migrate: "scripts/migrate.ts",
    admin: "scripts/admin.ts",
    "wait-db": "scripts/wait-db.ts",
    worker: "worker/index.ts",
    seed: "scripts/seed.ts",
    "plaid-backfill": "scripts/plaid-backfill.ts",
    "plaid-reset": "scripts/plaid-reset.ts",
  },
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: externals,
  logLevel: "info",
});
// Turbopack traces external packages under hashed aliases in .next/node_modules.
// The independent CLI bundles need their normal package names as well.
const require = createRequire(import.meta.url);
const repoRoot = path.resolve("../..");
const standaloneRoot = path.resolve(".next/standalone");
for (const name of externals) {
  const originalPackage = path.dirname(await realpath(require.resolve(`${name}/package.json`)));
  const tracedPackage = path.join(standaloneRoot, path.relative(repoRoot, originalPackage));
  await realpath(tracedPackage); // Fail the build if tracing omitted a required package.
  const alias = path.join(standaloneRoot, "apps/web/node_modules", name);
  await mkdir(path.dirname(alias), { recursive: true });
  try {
    await symlink(path.relative(path.dirname(alias), tracedPackage), alias);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
