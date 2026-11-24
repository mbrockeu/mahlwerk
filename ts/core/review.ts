// Weekly review (review.py): one strength and at most one thing to improve for a calendar week (Monday to Sunday). A pure
// function of the entries of that week and the week before, plus the goal; reuses the 90-110 % rule.
import { adherenceClass, mean } from './analysis.ts';
import { weekLabel } from './calendar.ts';
import { addDays, weekday } from './dates.ts';
import { asTimeline, current, goalOn, kcalOn, period, type GoalValues, type Timeline } from './goals.ts';
import { scale, type Per100 } from './nutrition.ts';
import { roundHalfEven } from './num.ts';

const QUIET_BELOW = 2; // fewer logged days: no verdict, only "quiet_week"
const FEW_DAYS = 4;
const IN_RANGE_DAYS = 5;
const PROTEIN_DAYS = 5;
const FIBER_STRONG = 30.0;
const FIBER_WEAK = 20.0;
const PROTEIN_WEAK = 0.8;
const WEEKEND_OVER = 1.2;
const EPS = 1e-9;

export const weekStart = (day: string): string => addDays(day, -weekday(day));

type DayTotals = Record<string, { kcal: number; protein: number; fiber: number }>;
type Avg = { kcal: number; protein: number; fiber: number };
export interface ReviewRow { day: string; per_100: Per100; amount: number }

/** Per logged day of the week starting at `first`: kcal, protein, fiber. */
function totals(rows: ReviewRow[], first: string): DayTotals {
  const last = addDays(first, 6);
  const out: DayTotals = {};
  for (const row of rows) {
    if (!(first <= row.day && row.day <= last)) continue;
    const values = scale(row.per_100, row.amount);
    const day = (out[row.day] ??= { kcal: 0.0, protein: 0.0, fiber: 0.0 });
    for (const key of ['kcal', 'protein', 'fiber'] as const) day[key] += values[key] || 0.0;
  }
  return out;
}

const r0 = roundHalfEven;
const sortedKeys = (o: object): string[] => Object.keys(o).sort();

/** `rows` hold the entries of this week and of the week before; `badgeCodes` the badges reached this week; `bonus` the kcal the
 * active energy adds to a day's goal. Each day counts against its own goal, the protein average against the mean goal. */
export function compute(monday: string, rows: ReviewRow[], goal: Timeline | GoalValues | null, badgeCodes: string[], bonus: Record<string, number> = {}) {
  const tl = asTimeline(goal);
  const thisWeek = totals(rows, monday);
  const before = totals(rows, addDays(monday, -7));
  const logged = sortedKeys(thisWeek);
  const n = logged.length;
  const avg: Avg = { kcal: mean(logged.map((d) => thisWeek[d].kcal)), protein: mean(logged.map((d) => thisWeek[d].protein)), fiber: mean(logged.map((d) => thisWeek[d].fiber)) };
  const days = [];
  for (let i = 0; i < 7; i++) {
    const iso = addDays(monday, i);
    const here = Object.hasOwn(thisWeek, iso);
    days.push({ day: iso, logged: here, kcal: here ? r0(thisWeek[iso].kcal) : 0, state: tl && here ? adherenceClass(thisWeek[iso].kcal, kcalOn(tl, bonus, iso)!) : null });
  }
  const result: Record<string, any> = {
    week: weekLabel(monday), from: monday, to: addDays(monday, 6), logged_days: n, kcal_avg: r0(avg.kcal),
    goal: tl ? current(tl) : null, days, best: null, improve: null, badges: badgeCodes,
  };
  if (n < QUIET_BELOW) {
    result.badges = ['quiet_week', ...badgeCodes];
    return result;
  }
  result.best = best(thisWeek, before, avg, tl, bonus);
  result.improve = improve(thisWeek, avg, tl ? period(tl, logged) : null);
  return result;
}

function best(thisWeek: DayTotals, before: DayTotals, avg: Avg, tl: Timeline | null, bonus: Record<string, number>) {
  const n = Object.keys(thisWeek).length;
  if (n === 7) return { code: 'all_days', params: { days: 7 } };
  if (tl) {
    let hit = Object.entries(thisWeek).filter(([d, v]) => adherenceClass(v.kcal, kcalOn(tl, bonus, d)!) === 'in').length;
    if (hit >= IN_RANGE_DAYS) return { code: 'in_range_days', params: { days: hit, of: n } };
    if (period(tl, Object.keys(thisWeek)).protein! > 0) {
      hit = Object.entries(thisWeek).filter(([d, v]) => { const g = goalOn(tl, d).protein; return g > 0 && v.protein >= g * 0.9 - EPS; }).length;
      if (hit >= PROTEIN_DAYS) return { code: 'protein_days', params: { days: hit, of: n } };
    }
  }
  if (avg.fiber >= FIBER_STRONG) return { code: 'fiber_avg', params: { avg: r0(avg.fiber) } };
  const nBefore = Object.keys(before).length;
  if (n > nBefore && nBefore >= 1) return { code: 'more_days', params: { days: n, before: nBefore } };
  return null;
}

function improve(thisWeek: DayTotals, avg: Avg, goal: Partial<GoalValues> | null) {
  const n = Object.keys(thisWeek).length;
  if (n < FEW_DAYS) return { code: 'few_days', params: { days: n } };
  if (goal && goal.protein! > 0 && avg.protein < goal.protein! * PROTEIN_WEAK) {
    return { code: 'low_protein', params: { avg: r0(avg.protein), goal: r0(goal.protein!), pct: r0((avg.protein / goal.protein!) * 100) } };
  }
  if (avg.fiber < FIBER_WEAK) return { code: 'low_fiber', params: { avg: r0(avg.fiber) } };
  const weekend = Object.entries(thisWeek).filter(([d]) => weekday(d) >= 5).map(([, v]) => v.kcal);
  const workdays = Object.entries(thisWeek).filter(([d]) => weekday(d) < 5).map(([, v]) => v.kcal);
  if (weekend.length && workdays.length >= 2 && mean(workdays) > 0 && mean(weekend) > mean(workdays) * WEEKEND_OVER) {
    return { code: 'weekend_higher', params: { weekend: r0(mean(weekend)), weekday: r0(mean(workdays)), pct: r0((mean(weekend) / mean(workdays) - 1) * 100) } };
  }
  return null;
}
