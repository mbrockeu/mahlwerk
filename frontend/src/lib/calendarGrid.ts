// Layout logic of the calendar on the evaluation page: which mode a period gets, how the days fall into weeks,
// where the months start. No DOM, no framework, no local-time arithmetic: days are "YYYY-MM-DD" strings and all
// date maths runs on UTC midnights, so daylight saving never moves a day. Tested by tests/calendar.test.mjs.

export type CalState = 'none' | 'under' | 'in_range' | 'over' | 'no_goal';
export interface CalDay { day: string; state: CalState }
/** One square of the grid. `inPeriod` is false for days of a month shown only to complete its weeks. */
export interface GridCell { day: string; state: CalState; inPeriod: boolean }
export type Row = (GridCell | null)[];
export interface MonthBlock { month: string; weeks: Row[] }
export interface WeekColumns {
  /** one entry per week, each with seven rows (null = outside the period) */
  weeks: Row[];
  /** column of the 1st of each month in the period (and of the first day), with the year shown on a new year */
  marks: { col: number; month: string; yearChanged: boolean }[];
  /** where a month starts inside the grid: col/row of its 1st (the first day of the period is no boundary) */
  starts: { col: number; row: number }[];
}

/** Up to this many days the calendar is a month view, above it the compact week-column view. */
export const MONTH_VIEW_MAX_DAYS = 56;
export const calendarMode = (days: number): 'months' | 'weeks' => (days <= MONTH_VIEW_MAX_DAYS ? 'months' : 'weeks');

const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const plus = (day: string, n: number) => iso(ms(day) + n * 86400000); // UTC midnights: 86400000 is exact there
const between = (a: string, b: string) => Math.round((ms(b) - ms(a)) / 86400000);

/** 0 = first day of the week … 6, for week starts Monday (1, the default; the whole app counts weeks from Monday) or Sunday (0). */
export function weekdayIndex(day: string, weekStart: 0 | 1 = 1): number {
  const dow = new Date(ms(day)).getUTCDay(); // 0 = Sunday
  return (dow - weekStart + 7) % 7;
}

/** The first day of the week a day belongs to. */
export const startOfWeek = (day: string, weekStart: 0 | 1 = 1) => plus(day, -weekdayIndex(day, weekStart));

/** Days sorted, duplicates dropped (the last one wins), gaps inside the range filled with "nothing logged". */
function dense(cal: CalDay[]): { first: string; last: string; map: Map<string, CalState> } | null {
  if (!cal.length) return null;
  const map = new Map(cal.map((d) => [d.day, d.state] as const));
  const keys = [...map.keys()].sort();
  return { first: keys[0], last: keys[keys.length - 1], map };
}

/** Month view: one block per month of the period, weeks as rows, blank squares for days of other months. */
export function monthBlocks(cal: CalDay[], weekStart: 0 | 1 = 1): MonthBlock[] {
  const d = dense(cal);
  if (!d) return [];
  const out: MonthBlock[] = [];
  for (let month = d.first.slice(0, 7); month <= d.last.slice(0, 7); month = nextMonth(month)) {
    const first = `${month}-01`;
    const last = plus(`${nextMonth(month)}-01`, -1);
    const weeks: Row[] = [];
    for (let w = startOfWeek(first, weekStart); w <= last; w = plus(w, 7)) {
      const row: Row = [];
      let any = false;
      for (let i = 0; i < 7; i += 1) {
        const day = plus(w, i);
        if (day.slice(0, 7) !== month) { row.push(null); continue; }
        const inPeriod = day >= d.first && day <= d.last;
        if (inPeriod) any = true;
        row.push({ day, state: inPeriod ? (d.map.get(day) ?? 'none') : 'none', inPeriod });
      }
      if (any) weeks.push(row);
    }
    out.push({ month, weeks });
  }
  return out;
}

function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** Compact view: one column per week over the whole period, weekdays as rows. */
export function weekColumns(cal: CalDay[], weekStart: 0 | 1 = 1): WeekColumns {
  const d = dense(cal);
  if (!d) return { weeks: [], marks: [], starts: [] };
  const weeks: Row[] = [];
  const marks: WeekColumns['marks'] = [];
  const starts: WeekColumns['starts'] = [];
  let lastMonth = '';
  let lastYear = '';
  let col = 0;
  for (let w = startOfWeek(d.first, weekStart); w <= d.last; w = plus(w, 7), col += 1) {
    const row: Row = [];
    for (let i = 0; i < 7; i += 1) {
      const day = plus(w, i);
      const inPeriod = day >= d.first && day <= d.last;
      row.push(inPeriod ? { day, state: d.map.get(day) ?? 'none', inPeriod } : null);
      if (!inPeriod) continue;
      const month = day.slice(0, 7);
      if (month !== lastMonth) {
        marks.push({ col, month, yearChanged: lastYear !== '' && month.slice(0, 4) !== lastYear });
        if (lastMonth !== '') starts.push({ col, row: i });
        lastMonth = month;
        lastYear = month.slice(0, 4);
      }
    }
    weeks.push(row);
  }
  return { weeks, marks, starts };
}

export interface Tally { total: number; in_range: number; under: number; over: number; no_goal: number; none: number; logged: number }
/** Counts per state; `logged` is every day with an entry (also those without a goal). */
export function tally(cal: CalDay[]): Tally {
  const t: Tally = { total: 0, in_range: 0, under: 0, over: 0, no_goal: 0, none: 0, logged: 0 };
  for (const d of new Map(cal.map((x) => [x.day, x.state] as const)).values()) {
    t.total += 1;
    t[d] += 1;
    if (d !== 'none') t.logged += 1;
  }
  return t;
}

/** Day reached with an arrow key (clamped to the period); `vertical` says whether days run down a column (week-column view). Null for other keys. */
export function arrowDay(key: string, vertical: boolean, day: string, first: string, last: string): string | null {
  const step = vertical ? { ArrowDown: 1, ArrowUp: -1, ArrowRight: 7, ArrowLeft: -7 } : { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 };
  let next: string;
  if (key in step) next = plus(day, step[key as keyof typeof step]);
  else if (key === 'Home') next = first;
  else if (key === 'End') next = last;
  else return null;
  return next < first ? first : next > last ? last : next;
}
