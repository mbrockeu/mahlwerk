// Labels for the sections (days, weeks, months) of the evaluation charts.
import { fromDay, isoWeek } from './date';
import { lang, t } from './i18n';
import type { Granularity, Section } from './types';

const f = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(lang, opts);
const dm = f({ day: 'numeric', month: 'numeric' });
const dmy = f({ day: 'numeric', month: 'numeric', year: '2-digit' });
const dLong = f({ weekday: 'short', day: 'numeric', month: 'numeric', year: '2-digit' });
const monthLong = f({ month: 'long', year: 'numeric' });
const monthShort = f({ month: 'short' });
const monthYear = f({ month: 'short', year: '2-digit' });

type Span = Pick<Section, 'start' | 'end'>;
const weekNo = (day: string) => Number(isoWeek(day).split('-W')[1]);

/** Long label for a readout: "Do 12.11.26", "10.3.–16.3.25 (KW 11)", "März 2025". */
export function sectionLabel(s: Span, g: Granularity): string {
  if (g === 'day') return dLong.format(fromDay(s.start));
  if (g === 'week') return `${dm.format(fromDay(s.start))}–${dmy.format(fromDay(s.end))} (${t('secWeekShort', { n: weekNo(s.start) })})`;
  return monthLong.format(fromDay(s.start));
}

/** Short label for an axis; months show the year too when the range spans more than a year. */
export function sectionShort(s: Span, g: Granularity, multiYear = false): string {
  if (g === 'month') return (multiYear ? monthYear : monthShort).format(fromDay(s.start));
  return (multiYear ? dmy : dm).format(fromDay(s.start));
}

export const dayLabel = (day: string) => dLong.format(fromDay(day));
export const monthOf = (month: string) => monthYear.format(fromDay(`${month}-01`));
export const monthLongOf = (month: string) => monthLong.format(fromDay(`${month}-01`));
