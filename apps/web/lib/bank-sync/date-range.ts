import type { PlaidConfig } from "./types";

export function shiftDate(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
export function effectiveFromDate(
  connection: { importFromDate: string },
  mapping?: { importFromDate: string | null },
) {
  return mapping?.importFromDate && mapping.importFromDate > connection.importFromDate
    ? mapping.importFromDate
    : connection.importFromDate;
}

type HistoryConfig = Pick<PlaidConfig, "PLAID_HISTORY_START" | "PLAID_DAYS_REQUESTED">;
export function historyStart(config: HistoryConfig, today: string) {
  const requested = config.PLAID_HISTORY_START || shiftDate(today, -config.PLAID_DAYS_REQUESTED);
  return requested < shiftDate(today, -730) ? shiftDate(today, -730) : requested;
}
export function historyDaysRequested(config: HistoryConfig, today: string) {
  if (!config.PLAID_HISTORY_START) return config.PLAID_DAYS_REQUESTED;
  const days = Math.round((Date.parse(today) - Date.parse(config.PLAID_HISTORY_START)) / 86400000) + 7;
  return Math.max(1, Math.min(730, days));
}
export function backfillDefault(config: HistoryConfig, today: string, current: string) {
  const start = historyStart(config, today);
  return current < start ? current : start;
}
export function availabilityStart(createdDate: string, daysRequested: number) {
  return shiftDate(createdDate, -daysRequested);
}
