import { shiftDate } from "./date-range";

export function formatSyncTime(value: string | Date, timezone: string, now = new Date()) {
  const time = typeof value === "string" ? new Date(value) : value;
  const localDate = (date: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  const date = localDate(time);
  const today = localDate(now);
  const label =
    date === today
      ? "今天"
      : date === shiftDate(today, -1)
        ? "昨天"
        : new Intl.DateTimeFormat("zh-CN", {
            timeZone: timezone,
            ...(date.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" as const } : {}),
            month: "long",
            day: "numeric",
          }).format(time);
  const clock = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(time);
  return `${label} ${clock}`;
}
