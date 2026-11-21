import { money } from "@/lib/money";
import type { DisplayInstance } from "./marks";

export function isUnqualifiedConditional(instance: DisplayInstance): boolean {
  if (!instance.conditions) return false;
  if (instance.status === "ok" && "year" in instance)
    return !money(instance.year.used).gt("0") && !instance.periods.some((period) => period.marked);
  if (instance.status === "estimated") return !money(instance.window.used).gt("0") && !instance.marked;
  return false;
}
export function benefitTotals(instances: DisplayInstance[]) {
  let cap = money("0"),
    used = money("0"),
    expiredUnused = money("0"),
    remaining = money("0"),
    conditionalCap = money("0");
  const excluded = { multiYear: 0, untracked: 0 };
  for (const instance of instances) {
    if (instance.status === "ok" && "year" in instance) {
      if (isUnqualifiedConditional(instance)) conditionalCap = conditionalCap.plus(instance.year.cap);
      else {
        cap = cap.plus(instance.year.cap);
        used = used.plus(instance.year.used);
        expiredUnused = expiredUnused.plus(instance.year.expired_unused);
        remaining = remaining.plus(instance.year.available).plus(instance.year.upcoming);
      }
    } else if (instance.status === "estimated") {
      if (isUnqualifiedConditional(instance)) conditionalCap = conditionalCap.plus(instance.window.cap);
      else {
        cap = cap.plus(instance.window.cap);
        used = used.plus(instance.window.used);
        remaining = remaining.plus(instance.window.remaining);
      }
    } else if (instance.status === "ok" && "eligible" in instance) excluded.multiYear++;
    else excluded.untracked++;
  }
  return {
    cap: cap.toFixed(4),
    used: used.toFixed(4),
    expiredUnused: expiredUnused.toFixed(4),
    remaining: remaining.toFixed(4),
    conditionalCap: conditionalCap.toFixed(4),
    excluded,
  };
}
