import { NextResponse } from "next/server";
import { resetRoute } from "@/lib/bank-sync/reset-http";
import { readResetRecovery } from "@/lib/bank-sync/reset-files";
export const GET = resetRoute(
  async (_request, { db, ownerId, id, config }) =>
    new NextResponse(await readResetRecovery(db, ownerId, id!, config), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="plaid-reset-${id}.json"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    }),
);
