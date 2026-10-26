import { NextResponse } from "next/server";
import { ledgerRoute } from "@/lib/ledger/http";
import { renderStatementPage } from "@/lib/imports/evidence";
import { readEnv } from "@/lib/env";
export const GET = ledgerRoute(async (request, { db, ownerId, id }) => {
  const png = await renderStatementPage(
    db,
    ownerId,
    id!,
    Number(request.nextUrl.searchParams.get("page") || "1"),
    readEnv(),
  );
  return new NextResponse(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
