import { decimal } from "@/lib/money/fx";
export function formatAmount(value: string, currency: string) {
  const [whole, fraction] = decimal(value).toFixed(2).split(".");
  return `${currency} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}
export function todayInTimezone(timezone: string, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
