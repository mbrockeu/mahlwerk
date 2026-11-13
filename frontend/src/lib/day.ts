// Calendar days as "YYYY-MM-DD" strings in local time, and ISO weeks. No imports: tested by tests/date.test.mjs.

export const pad = (n: number) => String(n).padStart(2, '0');

export const toDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => toDay(new Date());
export const fromDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
};
export const shiftDay = (day: string, delta: number) => {
  const d = fromDay(day);
  d.setDate(d.getDate() + delta);
  return toDay(d);
};
export const daysBetween = (a: string, b: string) => Math.round((fromDay(b).getTime() - fromDay(a).getTime()) / 86400000);

/** Monday of the week a day belongs to. */
export const weekStart = (day: string) => shiftDay(day, -((fromDay(day).getDay() + 6) % 7));
/** ISO week of a day as the API writes it: "2026-W07". */
export function isoWeek(day: string): string {
  const monday = weekStart(day);
  const thursday = fromDay(shiftDay(monday, 3));
  const jan1 = new Date(thursday.getFullYear(), 0, 1, 12);
  // whole days first: in summer time the Thursday is an hour "short" of 1 January, and flooring the weeks lost one
  const days = Math.round((thursday.getTime() - jan1.getTime()) / 86400000);
  const week = Math.floor(days / 7) + 1;
  return `${thursday.getFullYear()}-W${String(week).padStart(2, '0')}`;
}
/** Monday of an ISO week "2026-W07". */
export function mondayOfWeek(week: string): string {
  const [y, w] = week.split('-W').map(Number);
  const jan4 = toDay(new Date(y, 0, 4, 12));
  return shiftDay(weekStart(jan4), (w - 1) * 7);
}
