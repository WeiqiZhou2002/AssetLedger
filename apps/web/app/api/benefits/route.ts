import { eq } from "drizzle-orm";
import { z } from "zod";
import { users } from "@/db/schema";
import { benefitOverview } from "@/lib/benefits/queries";
import { invariant } from "@/lib/ledger/errors";
import { todayInTimezone } from "@/lib/ledger/format";
import { ledgerRoute } from "@/lib/ledger/http";

export const GET = ledgerRoute(async (request, { db, ownerId }) => {
  const [user] = await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, ownerId));
  invariant(user, "用户不存在", 404);
  const today = todayInTimezone(user.timezone);
  const year = z
    .string()
    .regex(/^\d{4}$/)
    .parse(request.nextUrl.searchParams.get("year") ?? today.slice(0, 4));
  return benefitOverview(db, ownerId, today, year);
});
