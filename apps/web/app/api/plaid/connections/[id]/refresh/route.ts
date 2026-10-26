import { plaidRoute } from "@/lib/bank-sync/http";
import { queueSync, requireConnection, token } from "@/lib/bank-sync/connections";
export const POST = plaidRoute(async (_request, { db, ownerId, client, config, id }) => {
  const result = await queueSync(db, ownerId, id!, config);
  const connection = await requireConnection(db, ownerId, id!);
  await client.refresh(token(connection, config));
  return result;
}, true);
