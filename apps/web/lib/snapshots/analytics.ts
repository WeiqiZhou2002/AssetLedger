import { and, eq, gt, lte, sql } from "drizzle-orm";
import { journalEntries, postings } from "@/db/schema";
import type { AppDb } from "@/db/types";
import { balancesAsOf } from "@/lib/ledger/queries";
import { decimal, isStale } from "@/lib/money/fx";
import { listSnapshots } from "./service";
import { listAccountGroups } from "./groups";
async function confirmedFlows(db: AppDb, ownerId: string, from: string, to: string) {
  const date = sql<string>`coalesce(${journalEntries.postedDate}, ${journalEntries.eventDate})`;
  return db
    .select({
      id: postings.id,
      entryId: postings.journalEntryId,
      accountId: postings.accountId,
      amount: postings.amount,
      currency: postings.currency,
      date,
    })
    .from(postings)
    .innerJoin(
      journalEntries,
      and(eq(journalEntries.id, postings.journalEntryId), eq(journalEntries.ownerId, ownerId)),
    )
    .where(
      and(
        eq(postings.ownerId, ownerId),
        eq(journalEntries.status, "confirmed"),
        gt(date, from),
        lte(date, to),
      ),
    );
}
export async function snapshotAnalytics(db: AppDb, ownerId: string, today: string, staleDays: number) {
  const [allSnapshots, accounts, groups] = await Promise.all([
    listSnapshots(db, ownerId),
    balancesAsOf(db, ownerId, today),
    listAccountGroups(db, ownerId),
  ]);
  const snapshots = allSnapshots.filter(
    (snapshot) => snapshot.status === "published" && snapshot.snapshotDate <= today,
  );
  const oldest = snapshots.at(-1)?.snapshotDate ?? today;
  const flows = await confirmedFlows(db, ownerId, oldest, today);
  const units = [
    ...accounts
      .filter((row) => row.type === "asset_security" && !row.accountGroupId)
      .map((row) => ({
        id: row.id,
        name: row.name,
        currency: row.currency,
        accountIds: [row.id],
        groupId: null as string | null,
      })),
    ...groups
      .filter((row) => row.isSecurity)
      .map((row) => ({
        id: `group:${row.id}`,
        name: row.name,
        currency: row.currency,
        accountIds: accounts
          .filter((account) => account.accountGroupId === row.id)
          .map((account) => account.id),
        groupId: row.id,
      })),
  ];
  const investments = units.map((unit) => {
    const observations = snapshots.flatMap((snapshot) => {
      const aggregate = unit.groupId
        ? snapshot.items.find((item) => item.accountGroupId === unit.groupId)
        : null;
      const members = snapshot.items.filter(
        (item) => item.accountId && unit.accountIds.includes(item.accountId),
      );
      if (!aggregate && (!unit.accountIds.length || members.length !== unit.accountIds.length)) return [];
      const items = aggregate ? [aggregate] : members;
      return [
        {
          date: snapshot.snapshotDate,
          snapshotId: snapshot.id,
          value: items.reduce((sum, item) => sum.plus(decimal(item.balanceNative)), decimal("0")).toFixed(4),
          itemIds: items.map((item) => item.id),
        },
      ];
    });
    const netInvested = accounts
      .filter((account) => unit.accountIds.includes(account.id))
      .reduce((sum, account) => sum.plus(decimal(account.balance)), decimal("0"))
      .toFixed(4);
    const [last, previous] = observations;
    const between =
      last && previous
        ? flows.filter(
            (flow) =>
              unit.accountIds.includes(flow.accountId) && flow.date > previous.date && flow.date <= last.date,
          )
        : [];
    const marketChange =
      last && previous
        ? decimal(last.value)
            .minus(decimal(previous.value))
            .minus(between.reduce((sum, flow) => sum.plus(decimal(flow.amount)), decimal("0")))
            .toFixed(4)
        : null;
    return {
      ...unit,
      observations,
      netInvested,
      marketChange,
      marketEntryIds: [...new Set(between.map((flow) => flow.entryId))],
      stale: !last || isStale(last.date, today, staleDays),
    };
  });
  return { investments, today };
}
