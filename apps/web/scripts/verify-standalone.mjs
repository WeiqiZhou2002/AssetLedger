import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import path from "node:path";
const standaloneRoot = path.resolve(".next/standalone");
const require = createRequire(path.join(standaloneRoot, "apps/web/dist/worker.cjs"));
for (const name of ["pg", "@node-rs/argon2"]) {
  const resolved = realpathSync(require.resolve(name));
  if (!resolved.startsWith(`${standaloneRoot}${path.sep}`))
    throw new Error(`Standalone dependency escaped: ${name}`);
  require(name);
}
console.log("Standalone CLI dependencies resolve within the image tree.");
