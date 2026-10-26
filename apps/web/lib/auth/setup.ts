import { randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { setupTokens, users } from "@/db/schema";
import { systemClock, type AppDb, type Clock } from "@/db/types";
import { createAdmin } from "./admin";
import { auditAuth } from "./audit";
import { hashToken, privateHash } from "./crypto";
import { limitedAttempt } from "./rate-limit";
import { createSession } from "./session";

export const SETUP_INVALID = "设置链接无效或已过期";
export async function hasUsers(db: AppDb) {
  return (await db.select({ id: users.id }).from(users).limit(1)).length > 0;
}
export async function validSetupToken(db: AppDb, token: string | undefined, now = new Date()) {
  if (!token || !/^[\w-]{43}$/.test(token)) return null;
  const [row] = await db
    .select({ id: setupTokens.id })
    .from(setupTokens)
    .where(and(eq(setupTokens.tokenHash, hashToken(token)), gt(setupTokens.expiresAt, now)));
  return row ?? null;
}
export async function createSetupLink(db: AppDb, clock: Clock = systemClock) {
  return db.transaction(async (tx) => {
    // Same key as admin.cjs, shared by CLI creation and browser completion.
    await tx.execute(sql`select pg_advisory_xact_lock(9171024)`);
    if (await hasUsers(tx)) return { kind: "setup_not_needed" as const };
    await tx.delete(setupTokens);
    const token = randomBytes(32).toString("base64url");
    const now = clock();
    await tx.insert(setupTokens).values({
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      createdAt: now,
      updatedAt: now,
    });
    return { kind: "setup_link" as const, path: `/setup?token=${token}` };
  });
}
const setupInput = z
  .object({
    token: z.string().regex(/^[\w-]{43}$/),
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
    password: z.string().min(12).max(1024),
    confirmPassword: z.string().min(12).max(1024),
  })
  .strict()
  .refine((value) => value.password === value.confirmPassword);
type SetupResult =
  { ok: false; status: 400 | 409; error: string } | { ok: true; token: string; expiresAt: Date };
export async function completeSetup(
  db: AppDb,
  input: unknown,
  context: { appSecret: string; ip: string; userAgent: string; baseCurrency: string; timezone: string },
  clock: Clock = systemClock,
): Promise<SetupResult> {
  return limitedAttempt(
    db,
    [privateHash(`ip:${context.ip}`, context.appSecret)],
    async (tx): Promise<SetupResult> => {
      await tx.execute(sql`select pg_advisory_xact_lock(9171024)`);
      if (await hasUsers(tx)) return { ok: false, status: 409, error: "已完成首次设置，请登录" };
      const tokenInput = z.object({ token: z.string().regex(/^[\w-]{43}$/) }).safeParse(input);
      if (!tokenInput.success) return { ok: false, status: 400, error: SETUP_INVALID };
      const row = await validSetupToken(tx, tokenInput.data.token, clock());
      if (!row) return { ok: false, status: 400, error: SETUP_INVALID };
      const parsed = setupInput.safeParse(input);
      if (!parsed.success)
        return {
          ok: false,
          status: 400,
          error: "请检查邮箱和密码；密码须为 12–1024 个字符且两次输入一致",
        };
      await tx.delete(setupTokens).where(eq(setupTokens.id, row.id));
      const user = await createAdmin(
        tx,
        {
          email: parsed.data.email,
          password: parsed.data.password,
          baseCurrency: context.baseCurrency,
          timezone: context.timezone,
        },
        true,
      );
      if (!user) throw new Error("setup_conflict");
      const session = await createSession(
        tx,
        user.id,
        { ipHash: privateHash(context.ip, context.appSecret), userAgent: context.userAgent },
        clock,
      );
      await auditAuth(tx, user.id, "setup.completed");
      return { ok: true, ...session };
    },
    clock,
  );
}
