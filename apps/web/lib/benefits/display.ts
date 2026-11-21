import { money, sumMoney } from "@/lib/money";
import type { DisplayInstance } from "./marks";

export function isUnqualifiedConditional(instance: DisplayInstance): boolean {
  if (!instance.conditions) return false;
  if (instance.status === "ok" && "year" in instance)
    return !money(instance.year.used).gt("0") && !instance.periods.some((period) => period.marked);
  if (instance.status === "estimated") return !money(instance.window.used).gt("0") && !instance.marked;
  return false;
}

export function creditYearReimbursed(instance: DisplayInstance, year: string, asOf: string): string {
  return sumMoney(
    instance.entry_details
      .filter((entry) => entry.date.startsWith(`${year}-`) && entry.date <= asOf)
      .map((entry) => entry.amount),
  ).toFixed(4);
}

export function creditStatus(
  instance: DisplayInstance,
  asOf: string,
  year = asOf.slice(0, 4),
): "used" | "partial" | "unused" | "upcoming" | "eligible" | "cooldown" | "conditional" | null {
  if (instance.status === "estimated" && year < asOf.slice(0, 4)) return null;
  if (isUnqualifiedConditional(instance)) return "conditional";
  if (instance.status === "ok" && "year" in instance) {
    const current = instance.current_period;
    if (!current || current.end < asOf) return null;
    if (current.marked || current.state === "full" || current.state === "over") return "used";
    return current.state;
  }
  if (instance.status === "estimated") {
    if (instance.marked || money(instance.window.used).gte(instance.window.cap)) return "used";
    return money(instance.window.used).isZero() ? "unused" : "partial";
  }
  if (instance.status === "ok" && "eligible" in instance) return instance.eligible ? "eligible" : "cooldown";
  return null;
}

export function groupCredits(instances: DisplayInstance[], reimbursedByCredit: Record<string, string>) {
  const reimbursed: DisplayInstance[] = [],
    main: DisplayInstance[] = [],
    other: DisplayInstance[] = [];
  for (const instance of instances) {
    if (money(reimbursedByCredit[instance.credit] ?? "0").gt("0")) reimbursed.push(instance);
    else if (
      (instance.status === "estimated" || (instance.status === "ok" && "year" in instance)) &&
      !isUnqualifiedConditional(instance)
    )
      main.push(instance);
    else other.push(instance);
  }
  return { main: [...reimbursed, ...main], other };
}
