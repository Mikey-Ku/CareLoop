// Calendar-day arithmetic on YYYY-MM-DD dates. Days are counted in UTC, so no time zone or DST
// change can move one; which local date an instant falls on is src/scheduler.ts localDate.

export const DAY_MS = 86_400_000;

/** Days since 1970-01-01 for a YYYY-MM-DD date, or NaN when it isn't a date. */
export function dayNumber(day: string): number {
  return Math.floor(Date.parse(day) / DAY_MS);
}

/** A real calendar date written YYYY-MM-DD: "2026-09-01" yes; "2026-02-30" and "2026-9-1" no. */
export function isCalendarDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && addDays(day, 0) === day;
}

/** YYYY-MM-DD plus n days (minus, when n is negative). */
export function addDays(day: string, n: number): string {
  const [y, mo, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

/** "Mon" for a YYYY-MM-DD date. */
export function weekdayShort(day: string): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${day}T00:00:00Z`).getUTCDay()] ?? "";
}
