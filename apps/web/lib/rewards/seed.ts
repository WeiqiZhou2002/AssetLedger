import { and, eq } from "drizzle-orm";
import { auditLogs, loyaltyCppHistory } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { auditLedger } from "@/lib/ledger/audit";
import { invariant } from "@/lib/ledger/errors";
import { daysBefore } from "./queries";
import { rewardsLock } from "./store";
import {
  createEvent,
  createObservation,
  listLoyaltyAccounts,
  listPrograms,
  saveLoyaltyAccount,
  setCpp,
  transferPoints,
} from "./service";

export async function seedDemoRewards(db: AppDb, ownerId: string, today: string) {
  return db.transaction(async (tx) => {
    await rewardsLock(tx, ownerId);
    const markers = await tx.select().from(auditLogs).where(eq(auditLogs.ownerId, ownerId));
    invariant(
      markers.some((row) => row.action === "demo.seed"),
      "积分种子仅限独立演示用户",
    );
    // One atomic batch, independent of the invocation date; never reset edited demo balances.
    if (markers.some((row) => row.action === "demo.rewards.v1")) return;
    const programs = await listPrograms(tx, ownerId);
    const existing = await listLoyaltyAccounts(tx, ownerId);
    const account = async (code: string) => {
      const program = programs.find((row) => row.code === code);
      invariant(program, "缺少演示积分项目");
      const name = `Demo ${code} Rewards`;
      return (
        existing.find((row) => row.programId === program.id && row.name === name) ??
        (await saveLoyaltyAccount(tx, ownerId, {
          programId: program.id,
          name,
          notes: "合成演示账户，不包含真实会员资料",
        }))
      );
    };
    const mr = await account("MR");
    const aa = await account("AA");
    const ur = await account("UR");
    const hyatt = await account("HYATT");
    for (const [id, points, days, reference] of [
      [mr.id, "32000", 25, "mr-initial"],
      [mr.id, "1800", 10, "mr-earned"],
      [ur.id, "40000", 18, "ur-earned"],
    ] as const) {
      await createEvent(tx, ownerId, {
        loyaltyAccountId: id,
        eventDate: daysBefore(today, days),
        pointsDelta: points,
        type: "earn",
        externalReference: `demo-rewards-v1:${reference}`,
        note: "合成积分获取",
      });
    }
    await createObservation(tx, ownerId, {
      loyaltyAccountId: aa.id,
      observedOn: daysBefore(today, 20),
      balance: "72000",
    });
    await transferPoints(tx, ownerId, {
      fromAccountId: ur.id,
      toAccountId: hyatt.id,
      fromPoints: "15000",
      toPoints: "15000",
      eventDate: daysBefore(today, 7),
      note: "合成 UR → Hyatt 转点",
    });
    const effectiveDate = daysBefore(today, 3);
    const [rule] = await tx
      .select({ id: loyaltyCppHistory.id })
      .from(loyaltyCppHistory)
      .where(
        and(
          eq(loyaltyCppHistory.ownerId, ownerId),
          eq(loyaltyCppHistory.programId, mr.programId),
          eq(loyaltyCppHistory.effectiveDate, effectiveDate),
        ),
      );
    if (!rule) {
      await setCpp(tx, ownerId, {
        programId: mr.programId,
        effectiveDate,
        cppBaseline: "1",
        cppPersonal: "1.4",
        note: "合成个人 CPP 假设变更",
      });
    }
    await auditLedger(tx, ownerId, "user", ownerId, "demo.rewards.v1");
  });
}
