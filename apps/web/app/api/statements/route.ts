import { ledgerRoute } from "@/lib/ledger/http";
import { readEnv } from "@/lib/env";
import { boundedForm } from "@/lib/imports/files";
import { listStatements, uploadStatement } from "@/lib/imports/service";
export const GET = ledgerRoute(async (_request, { db, ownerId }) => listStatements(db, ownerId));
export const POST = ledgerRoute(async (request, { db, ownerId }) => {
  const env = readEnv();
  const { data, file } = await boundedForm(request, env.MAX_UPLOAD_MB * 1024 * 1024);
  return uploadStatement(
    db,
    ownerId,
    {
      bytes: new Uint8Array(await file.arrayBuffer()),
      filename: file.name,
      accountId: String(data.get("accountId") || "") || undefined,
      password: String(data.get("password") || "") || undefined,
    },
    env,
  );
}, true);
