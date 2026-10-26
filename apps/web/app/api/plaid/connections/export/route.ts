import { NextResponse } from "next/server";
import { loginContext } from "@/lib/auth/http";
import { ledgerBody } from "@/lib/ledger/http";
import { plaidRoute } from "@/lib/bank-sync/http";
import { exportConnections } from "@/lib/bank-sync/connection-export";
import { transferRequest } from "@/lib/bank-sync/transfer-http";
export const POST = plaidRoute(
  async (request, { db, ownerId, config }) =>
    transferRequest(async () => {
      const bundle = await exportConnections(
        db,
        ownerId,
        config,
        await ledgerBody(request),
        loginContext(request).ip,
      );
      return new NextResponse(JSON.stringify(bundle), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="asset-ledger-plaid-connections-${bundle.createdAt.slice(0, 10)}.json"`,
        },
      });
    }),
  true,
);
