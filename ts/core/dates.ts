// Calendar days as ISO strings `YYYY-MM-DD` (datetime.date of the Python side). All arithmetic is in UTC, so no DST.

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The day as UTC midnight, or null when it is no real date (2025-02-30, year 0000). Python: date.fromisoformat. */
export function dayToDate(day: string): Date | null {
  if (!DAY_RE.test(day)) return null;
  const [y, m, d] = [Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10))];
  if (y < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t : null;
}

export const dateToDay = (d: Date): string => d.toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  return dateToDay(new Date(dayToDate(day)!.getTime() + n * DAY_MS));
}

/** Whole days from `a` to `b` (b - a). */
export const daysBetween = (a: string, b: string): number => Math.round((dayToDate(b)!.getTime() - dayToDate(a)!.getTime()) / DAY_MS);

/** Monday = 0 … Sunday = 6 (date.weekday()). */
export const weekday = (day: string): number => (dayToDate(day)!.getUTCDay() + 6) % 7;

/** date.toordinal(): 0001-01-01 is 1. */
export const toOrdinal = (day: string): number => Math.round(dayToDate(day)!.getTime() / DAY_MS) + 719163;

/** date.today() of the server: the local calendar day of the machine. */
export function today(): string {
  const n = new Date();
  return `${String(n.getFullYear()).padStart(4, '0')}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}
