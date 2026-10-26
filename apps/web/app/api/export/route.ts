import { NextResponse } from "next/server";
import { z } from "zod";
import { ledgerRoute } from "@/lib/ledger/http";
import { exportOwnerCsv, exportOwnerData } from "@/lib/data/export";
export const GET = ledgerRoute(async (request, { db, ownerId }) => {
  const format = z.enum(["json", "csv"]).parse(request.nextUrl.searchParams.get("format") ?? "json");
  const table = request.nextUrl.searchParams.get("table") ?? "profile";
  const body =
    format === "json"
      ? JSON.stringify(await exportOwnerData(db, ownerId), null, 2)
      : await exportOwnerCsv(db, ownerId, table);
  return new NextResponse(body, {
    headers: {
      "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="asset-ledger-${format === "json" ? "data" : table}.${format}"`,
      "Cache-Control": "no-store",
    },
  });
});
