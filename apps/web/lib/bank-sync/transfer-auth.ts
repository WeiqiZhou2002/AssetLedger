import { eq } from "drizzle-orm";
import { z } from "zod";
import { users } from "@/db/schema";
import { systemClock, type AppDb, type Clock } from "@/db/types";
import { verifyPassword } from "@/lib/auth/password";
import { consumeTotp } from "@/lib/auth/totp";
import { limitedAttempt, rateKeys } from "@/lib/auth/rate-limit";
import { invariant, LedgerError } from "@/lib/ledger/errors";
export const transferCredentials = z.object({
  code: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
  password: z.string().min(1).max(1024).optional(),
});
export async function authorizeTransfer<T>(
  db: AppDb,
  ownerId: string,
  credentials: z.infer<typeof transferCredentials>,
  context: { appSecret: string; ip: string },
  prepare: (passwordHash: string) => Promise<T>,
  clock: Clock = systemClock,
) {
  const [owner] = await db.select({ email: users.email }).from(users).where(eq(users.id, ownerId));
  invariant(owner, "用户不存在", 404);
  const invalid = "验证失败，密码或验证码无效或已使用，请重试";
  const result = await limitedAttempt(
    db,
    rateKeys(owner.email, context.ip, context.appSecret),
    async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, ownerId)).for("update");
      const verified =
        user &&
        (user.totpEnabledAt
          ? Boolean(
              credentials.code &&
              (await consumeTotp(tx, ownerId, credentials.code, context.appSecret, clock)),
            )
          : Boolean(credentials.password && (await verifyPassword(user.passwordHash, credentials.password))));
      if (!verified) return { ok: false as const, error: new LedgerError(invalid) };
      try {
        return { ok: true as const, value: await prepare(user.passwordHash) };
      } catch (error) {
        // Commit failed attempts and consumed TOTP steps, including bad bundle passphrases.
        if (error instanceof LedgerError) return { ok: false as const, error };
        throw error;
      }
    },
    clock,
  );
  if (!result.ok) throw result.error;
  return result.value;
}
