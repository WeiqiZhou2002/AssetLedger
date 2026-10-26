import "../apps/web/scripts/env";
import { readEnv } from "../apps/web/lib/env";
import { getPool } from "../apps/web/db/client";
import { sandboxSmoke } from "../apps/web/lib/bank-sync/smoke";
import { plaidError } from "../apps/web/lib/bank-sync/plaid-client";
const args = process.argv.slice(2);
const ownerEmail = args[0] === "--import" && args.length === 2 ? args[1] : undefined;
async function main() {
  if (args.length && !ownerEmail) throw new Error("invalid_arguments");
  const env = readEnv();
  if (env.PLAID_ENV !== "sandbox") throw new Error("sandbox_only");
  await sandboxSmoke(env, ownerEmail);
}
main()
  .catch((error) => {
    const safe = plaidError(error);
    console.error(JSON.stringify({ error_code: safe.errorCode, request_id: safe.requestId }));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (ownerEmail) await getPool().end();
  });
