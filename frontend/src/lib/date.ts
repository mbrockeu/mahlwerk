// Local calendar days as "YYYY-MM-DD" strings.
import { lang } from './i18n';

export * from './day';
import { fromDay, pad, toDay } from './day';

/** "DO 12.11." */
export function shortDate(day: string): string {
  const d = fromDay(day);
  const wd = new Intl.DateTimeFormat(lang, { weekday: 'short' }).format(d).replace('.', '');
  const date = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'numeric' }).format(d);
  return `${wd} ${date}`.toUpperCase();
}
export const weekdayLong = (day: string) => new Intl.DateTimeFormat(lang, { weekday: 'long' }).format(fromDay(day));
export const weekdayInitial = (day: string) =>
  new Intl.DateTimeFormat(lang, { weekday: 'short' }).format(fromDay(day)).replace('.', '').slice(0, 2).toUpperCase();
export const dayOfMonth = (day: string) => fromDay(day).getDate();


/** Time of day of a Unix timestamp in local time; another day than `nowSeconds` gets a short weekday in front. */
export function clock(unixSeconds: number, nowSeconds = Date.now() / 1000): string {
  const d = new Date(unixSeconds * 1000);
  const time = new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(d);
  if (toDay(d) === toDay(new Date(nowSeconds * 1000))) return time;
  return `${new Intl.DateTimeFormat(lang, { weekday: 'short' }).format(d).replace('.', '')} ${time}`;
}
/** Value for an `<input type="datetime-local">` (local time, minutes). */
export const toLocalInput = (unixSeconds: number) => {
  const d = new Date(unixSeconds * 1000);
  return `${toDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** Unix seconds of such a value; NaN when empty or invalid. */
export const fromLocalInput = (value: string) => Math.floor(new Date(value).getTime() / 1000);
/** "13:42" for a duration in seconds (hours are not wrapped at 24). */
export const hoursMinutes = (seconds: number) => {
  const m = Math.floor(Math.max(0, seconds) / 60);
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};
