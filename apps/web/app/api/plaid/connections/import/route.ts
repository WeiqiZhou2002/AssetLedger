import { loginContext } from "@/lib/auth/http";
import { plaidRoute } from "@/lib/bank-sync/http";
import { importConnections } from "@/lib/bank-sync/connection-import";
import { readTransferForm, transferRequest } from "@/lib/bank-sync/transfer-http";
export const POST = plaidRoute(
  async (request, { db, ownerId, config, client }) =>
    transferRequest(async () => {
      const { file, credentials } = await readTransferForm(request);
      return importConnections(db, ownerId, client, config, file, credentials, loginContext(request).ip);
    }),
  true,
);
