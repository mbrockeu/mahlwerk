// Calendar helpers the evaluation needs on top of dates.ts: ISO weeks, months, and local time of a unix timestamp.
import { addDays, dayToDate, daysBetween, weekday } from './dates.ts';

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** [ISO year, ISO week] of a day (date.isocalendar()). */
export function isoWeek(day: string): [number, number] {
  const thursday = addDays(day, 3 - weekday(day));
  const year = Number(thursday.slice(0, 4));
  return [year, Math.floor(daysBetween(`${pad(year, 4)}-01-01`, thursday) / 7) + 1];
}

/** "2026-W07" for the week that contains `day`. */
export function weekLabel(day: string): string {
  const [year, week] = isoWeek(day);
  return `${year}-W${pad(week, 2)}`;
}

/** date.fromisocalendar(year, week, 1): the Monday of an ISO week, null for a week that does not exist. */
export function mondayOfIsoWeek(year: number, week: number): string | null {
  if (year < 1 || year > 9999 || week < 1 || week > 53) return null;
  const jan4 = `${pad(year, 4)}-01-04`;
  const monday = addDays(jan4, -weekday(jan4) + 7 * (week - 1));
  const [y, w] = isoWeek(monday);
  return y === year && w === week && dayToDate(monday) ? monday : null;
}

/** Number of days of a month (calendar.monthrange(year, month)[1]). */
export const monthDays = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The local calendar day of a unix timestamp (datetime.fromtimestamp(s).date()). */
export function localDay(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
}

/** Unix seconds as ISO 8601 in the local time zone with the offset, to the second ("2026-11-14T20:15:00+01:00"). */
export function isoLocal(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined) return null;
  const d = new Date(seconds * 1000);
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return `${localDay(seconds)}T${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}${sign}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`;
}
