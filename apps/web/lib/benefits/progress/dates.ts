export function parts(date: string): [number, number, number] {
  const [year, month, day] = date.split("-").map(Number);
  return [year, month, day];
}
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
export function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
export function addMonths(anchor: string, months: number): string {
  const [year, month, day] = parts(anchor);
  const total = year * 12 + month - 1 + months;
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  return iso(y, m, Math.min(day, daysInMonth(y, m)));
}
export const addYears = (anchor: string, years: number) => addMonths(anchor, years * 12);
export function addDays(date: string, count: number): string {
  let [year, month, day] = parts(date);
  day += count;
  while (day < 1) {
    month -= 1;
    if (month < 1) {
      year -= 1;
      month = 12;
    }
    day += daysInMonth(year, month);
  }
  while (day > daysInMonth(year, month)) {
    day -= daysInMonth(year, month);
    month += 1;
    if (month > 12) {
      year += 1;
      month = 1;
    }
  }
  return iso(year, month, day);
}
export function monthDistance(from: string, to: string): number {
  const [fy, fm] = parts(from),
    [ty, tm] = parts(to);
  return (ty - fy) * 12 + tm - fm;
}
export function statementOnOrAfter(date: string, closeDay: number): string {
  const [year, month] = parts(date);
  const candidate = iso(year, month, Math.min(closeDay, daysInMonth(year, month)));
  if (candidate >= date) return candidate;
  const [ny, nm] = parts(addMonths(iso(year, month, 1), 1));
  return iso(ny, nm, Math.min(closeDay, daysInMonth(ny, nm)));
}
