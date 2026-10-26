import { ledgerRoute, ledgerBody } from "@/lib/ledger/http";
import { approveRows } from "@/lib/imports/approval";
import { readEnv } from "@/lib/env";
export const POST = ledgerRoute(
  async (request, { db, ownerId, id }) =>
    approveRows(db, ownerId, id!, await ledgerBody(request), readEnv().FILE_RETENTION_DAYS),
  true,
);
