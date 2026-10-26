import { eq } from "drizzle-orm";
import { z } from "zod";
import { users } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { hashPassword } from "./password";
import { auditAuth } from "./audit";
export async function createAdmin(
  db: AppDb,
  input: { email: string; password: string; baseCurrency: string; timezone: string },
  onlyIfEmpty = false,
) {
  if (onlyIfEmpty && (await db.select({ id: users.id }).from(users).limit(1)).length) return null;
  const email = z.email().max(254).parse(input.email.trim().toLowerCase());
  if ((await db.select({ id: users.id }).from(users).where(eq(users.email, email))).length)
    throw new Error("该用户已存在");
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email, passwordHash, baseCurrency: input.baseCurrency, timezone: input.timezone })
      .returning({ id: users.id });
    await auditAuth(tx, user.id, "user.bootstrap");
    return user;
  });
}
