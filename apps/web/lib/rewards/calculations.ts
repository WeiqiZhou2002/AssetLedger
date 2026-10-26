import type { loyaltyEvents, loyaltyObservations, loyaltyCppHistory } from "@/db/schema";
import { decimal } from "@/lib/money/fx";
type PointsEvent = Pick<typeof loyaltyEvents.$inferSelect, "id" | "eventDate" | "pointsDelta" | "type">;
type PointsObservation = Pick<typeof loyaltyObservations.$inferSelect, "id" | "observedOn" | "balance">;
type Cpp = Pick<
  typeof loyaltyCppHistory.$inferSelect,
  "id" | "effectiveDate" | "cppBaseline" | "cppPersonal"
>;
export function pointsAsOf(events: PointsEvent[], observations: PointsObservation[], date: string) {
  const anchor = observations
    .filter((row) => row.observedOn <= date)
    .sort((a, b) => b.observedOn.localeCompare(a.observedOn))[0];
  const flows = events.filter(
    (row) => row.eventDate <= date && (!anchor || row.eventDate > anchor.observedOn),
  );
  return {
    points: flows.reduce((sum, row) => sum + row.pointsDelta, anchor?.balance ?? 0n),
    observationId: anchor?.id ?? null,
    eventIds: flows.map((row) => row.id),
  };
}
export function cppAsOf(history: Cpp[], date: string) {
  return (
    history
      .filter((row) => row.effectiveDate <= date)
      .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0] ?? null
  );
}
export function pointsValue(points: bigint, cpp: string) {
  return decimal(points.toString()).mul(decimal(cpp)).div("100");
}
export function valueChange(points0: bigint, points1: bigint, cpp0: string, cpp1: string) {
  const quantityEffect = pointsValue(points1 - points0, cpp0);
  const cppEffect = decimal(points1.toString())
    .mul(decimal(cpp1).minus(decimal(cpp0)))
    .div("100");
  return {
    quantityEffect: quantityEffect.toFixed(),
    cppEffect: cppEffect.toFixed(),
    totalChange: pointsValue(points1, cpp1).minus(pointsValue(points0, cpp0)).toFixed(),
  };
}
export function reconcilePoints(events: PointsEvent[], observations: PointsObservation[]) {
  const sorted = [...observations].sort((a, b) => a.observedOn.localeCompare(b.observedOn));
  return sorted.map((observation, index) => {
    const prior = sorted[index - 1];
    if (!prior)
      return { ...observation, previousId: null, expected: null, difference: null, eventIds: [] as string[] };
    const flows = events.filter(
      (row) => row.eventDate > prior.observedOn && row.eventDate <= observation.observedOn,
    );
    const expected = flows.reduce((sum, row) => sum + row.pointsDelta, prior.balance);
    return {
      ...observation,
      previousId: prior.id,
      expected,
      difference: expected - observation.balance,
      eventIds: flows.map((row) => row.id),
    };
  });
}
