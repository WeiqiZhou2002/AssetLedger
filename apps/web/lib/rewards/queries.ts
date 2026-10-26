import { eq } from "drizzle-orm";
import type { AppDb } from "@/db/types";
import {
  loyaltyAccounts,
  loyaltyEvents,
  loyaltyObservations,
  loyaltyCppHistory,
  loyaltyTransfers,
} from "@/db/schema";
import { dateSchema } from "@/lib/ledger/schemas";
import { decimal } from "@/lib/money/fx";
import { jsonSafe } from "@/lib/serialization";
import { listPrograms } from "./service";
import { cppAsOf, pointsAsOf, pointsValue, reconcilePoints, valueChange } from "./calculations";
export function daysBefore(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
}
export async function rewardsOverview(db: AppDb, ownerId: string, asOf: string) {
  dateSchema.parse(asOf);
  const programs = await listPrograms(db, ownerId);
  const [accounts, events, observations, history, transfers] = await Promise.all([
    db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.ownerId, ownerId)),
    db
      .select()
      .from(loyaltyEvents)
      .where(eq(loyaltyEvents.ownerId, ownerId))
      .orderBy(loyaltyEvents.eventDate),
    db
      .select()
      .from(loyaltyObservations)
      .where(eq(loyaltyObservations.ownerId, ownerId))
      .orderBy(loyaltyObservations.observedOn),
    db
      .select()
      .from(loyaltyCppHistory)
      .where(eq(loyaltyCppHistory.ownerId, ownerId))
      .orderBy(loyaltyCppHistory.effectiveDate),
    db.select().from(loyaltyTransfers).where(eq(loyaltyTransfers.ownerId, ownerId)),
  ]);
  const from = daysBefore(asOf, 30);
  const details = accounts.map((account) => {
    const ownEvents = events.filter((row) => row.loyaltyAccountId === account.id);
    const ownObservations = observations.filter((row) => row.loyaltyAccountId === account.id);
    const ownHistory = history.filter((row) => row.programId === account.programId);
    const current = pointsAsOf(ownEvents, ownObservations, asOf);
    const previous = pointsAsOf(ownEvents, ownObservations, from);
    const cpp = cppAsOf(ownHistory, asOf);
    const priorCpp = cppAsOf(ownHistory, from);
    const valuation = cpp
      ? {
          baseline: pointsValue(current.points, cpp.cppBaseline).toFixed(),
          personal: pointsValue(current.points, cpp.cppPersonal).toFixed(),
        }
      : null;
    const decomposition =
      cpp && priorCpp
        ? {
            baseline: valueChange(previous.points, current.points, priorCpp.cppBaseline, cpp.cppBaseline),
            personal: valueChange(previous.points, current.points, priorCpp.cppPersonal, cpp.cppPersonal),
          }
        : null;
    const dates = [
      ...new Set([
        from,
        asOf,
        ...ownEvents.map((row) => row.eventDate),
        ...ownObservations.map((row) => row.observedOn),
        ...ownHistory.map((row) => row.effectiveDate),
      ]),
    ]
      .filter((date) => date >= from && date <= asOf)
      .sort();
    const chart = dates.map((date) => {
      const points = pointsAsOf(ownEvents, ownObservations, date).points;
      const valuation = cppAsOf(ownHistory, date);
      return {
        date,
        points,
        baseline: valuation ? pointsValue(points, valuation.cppBaseline).toFixed() : null,
        personal: valuation ? pointsValue(points, valuation.cppPersonal).toFixed() : null,
      };
    });
    const cumulative = (types: string[], negative = false) =>
      ownEvents
        .filter((row) => row.eventDate <= asOf && types.includes(row.type))
        .reduce((sum, row) => sum + (negative ? -row.pointsDelta : row.pointsDelta), 0n);
    return {
      ...account,
      program: programs.find((row) => row.id === account.programId)!,
      points: current.points,
      provenance: current,
      change30: current.points - previous.points,
      earned: cumulative(["earn", "bonus"]),
      redeemed: cumulative(["redeem"], true),
      cpp,
      valuation,
      decomposition,
      chart,
      events: ownEvents,
      observations: ownObservations,
      reconciliation: reconcilePoints(ownEvents, ownObservations),
      cppHistory: ownHistory,
    };
  });
  const programTotals = programs.map((program) => {
    const members = details.filter((account) => account.programId === program.id);
    return {
      ...program,
      accountCount: members.length,
      points: members.reduce((sum, row) => sum + row.points, 0n),
      baseline: members
        .reduce((sum, row) => sum.plus(row.valuation?.baseline ?? "0"), decimal("0"))
        .toFixed(),
      personal: members
        .reduce((sum, row) => sum.plus(row.valuation?.personal ?? "0"), decimal("0"))
        .toFixed(),
    };
  });
  return jsonSafe({
    asOf,
    from,
    programs: programTotals,
    accounts: details,
    history,
    transfers,
    totalBaseline: details
      .reduce((sum, row) => sum.plus(row.valuation?.baseline ?? "0"), decimal("0"))
      .toFixed(),
    totalPersonal: details
      .reduce((sum, row) => sum.plus(row.valuation?.personal ?? "0"), decimal("0"))
      .toFixed(),
    unvaluedAccounts: details.filter((row) => !row.valuation).length,
  });
}
export type RewardsOverview = Awaited<ReturnType<typeof rewardsOverview>>;
