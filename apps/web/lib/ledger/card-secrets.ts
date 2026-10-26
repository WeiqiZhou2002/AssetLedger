import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { accountCardSecrets, accounts, users } from "@/db/schema";
import { systemClock, type AppDb, type Clock } from "@/db/types";
import { decryptSecret, encryptSecret } from "@/lib/auth/crypto";
import { verifyPassword } from "@/lib/auth/password";
import { limitedAttempt, rateKeys } from "@/lib/auth/rate-limit";
import { consumeTotp } from "@/lib/auth/totp";
import { auditLedger } from "./audit";
import { requireAccount } from "./accounts";
import { cardNetwork, cardSchema } from "./card-schema";
import { invariant } from "./errors";

// Only these fields may leave the vault through list/page/save responses.
const metaColumns = {
  accountId: accountCardSecrets.accountId,
  numberLast4: accountCardSecrets.numberLast4,
  network: accountCardSecrets.network,
  hasExpiry: accountCardSecrets.hasExpiry,
  hasCvv: accountCardSecrets.hasCvv,
  hasCid: accountCardSecrets.hasCid,
};
export async function cardMeta(db: AppDb, ownerId: string, accountId?: string) {
  return db
    .select(metaColumns)
    .from(accountCardSecrets)
    .where(
      and(
        eq(accountCardSecrets.ownerId, ownerId),
        accountId ? eq(accountCardSecrets.accountId, accountId) : undefined,
      ),
    );
}
export type CardMeta = Awaited<ReturnType<typeof cardMeta>>[number];
async function lockCardAccount(db: AppDb, ownerId: string, id: string) {
  const [account] = await db
    .select({ id: accounts.id, type: accounts.type, isSystem: accounts.isSystem, last4: accounts.last4 })
    .from(accounts)
    .where(and(eq(accounts.ownerId, ownerId), eq(accounts.id, id)))
    .for("update");
  invariant(account, "账户不存在", 404);
  invariant(
    !account.isSystem && ["liability_credit_card", "asset_cash"].includes(account.type),
    "仅信用卡或现金账户可保存卡片信息",
  );
  return account;
}
export async function saveCard(
  db: AppDb,
  ownerId: string,
  accountId: string,
  input: unknown,
  appSecret: string,
) {
  return db.transaction(async (tx) => {
    const account = await lockCardAccount(tx, ownerId, accountId);
    const parsed = cardSchema.safeParse(input);
    // Only fixed, authored messages; never serialize input or Zod issues containing card data.
    invariant(
      parsed.success,
      parsed.error?.issues.find((issue) => issue.path.length > 0 && issue.code !== "unrecognized_keys")
        ?.message ?? "卡片信息格式无效，请检查必填项",
    );
    const payload = parsed.data;
    const metadata = {
      numberLast4: payload.number.slice(-4),
      network: cardNetwork(payload.number),
      hasExpiry: true,
      hasCvv: Boolean(payload.cvv),
      hasCid: Boolean(payload.cid),
    };
    if (metadata.network === "amex" && (!account.last4 || account.last4 === metadata.numberLast4)) {
      await tx
        .update(accounts)
        .set({ last4: payload.number.slice(-5) })
        .where(and(eq(accounts.ownerId, ownerId), eq(accounts.id, accountId)));
      await auditLedger(tx, ownerId, "account", accountId, "account.card_suffix_updated");
    }
    const values = {
      ...metadata,
      payloadEnc: encryptSecret(JSON.stringify(payload), appSecret, "account-card"),
    };
    await tx
      .insert(accountCardSecrets)
      .values({ ownerId, accountId, ...values })
      .onConflictDoUpdate({
        target: [accountCardSecrets.ownerId, accountCardSecrets.accountId],
        set: values,
      });
    await auditLedger(tx, ownerId, "account", accountId, "account_card.saved");
    return { accountId, ...metadata };
  });
}
export async function deleteCard(db: AppDb, ownerId: string, accountId: string) {
  return db.transaction(async (tx) => {
    await lockCardAccount(tx, ownerId, accountId);
    await tx
      .delete(accountCardSecrets)
      .where(and(eq(accountCardSecrets.ownerId, ownerId), eq(accountCardSecrets.accountId, accountId)));
    await auditLedger(tx, ownerId, "account", accountId, "account_card.deleted");
    return { deleted: true };
  });
}
const verificationSchema = z
  .object({
    code: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    password: z.string().min(1).max(1024).optional(),
  })
  .strict();
export async function revealCard(
  db: AppDb,
  ownerId: string,
  accountId: string,
  input: unknown,
  context: { appSecret: string; ip: string },
  clock: Clock = systemClock,
) {
  await requireAccount(db, ownerId, accountId);
  const credentials = verificationSchema.safeParse(input);
  const invalid = "验证失败，密码或验证码无效或已使用，请重试";
  invariant(credentials.success, invalid);
  const [owner] = await db.select({ email: users.email }).from(users).where(eq(users.id, ownerId));
  invariant(owner, "用户不存在", 404);
  const result = await limitedAttempt(
    db,
    rateKeys(owner.email, context.ip, context.appSecret),
    async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, ownerId)).for("update");
      const verified =
        user &&
        (user.totpEnabledAt
          ? Boolean(
              credentials.data.code &&
              (await consumeTotp(tx, ownerId, credentials.data.code, context.appSecret, clock)),
            )
          : Boolean(
              credentials.data.password &&
              (await verifyPassword(user.passwordHash, credentials.data.password)),
            ));
      // Return failures so the limiter transaction commits the failed attempt.
      if (!verified) return { ok: false as const, card: null };
      const [stored] = await tx
        .select({ payloadEnc: accountCardSecrets.payloadEnc })
        .from(accountCardSecrets)
        .where(and(eq(accountCardSecrets.ownerId, ownerId), eq(accountCardSecrets.accountId, accountId)));
      invariant(stored, "尚未保存卡片信息", 404);
      const card = cardSchema.parse(
        JSON.parse(decryptSecret(stored.payloadEnc, context.appSecret, "account-card")),
      );
      await auditLedger(tx, ownerId, "account", accountId, "account_card.revealed");
      return { ok: true as const, card };
    },
    clock,
  );
  invariant(result.ok, invalid);
  return result.card;
}
