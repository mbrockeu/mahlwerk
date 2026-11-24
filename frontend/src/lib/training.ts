// The training rhythm: a copy of the rules in src/mahlwerk/activity.py (week_block, training_days) and of the training block of
// src/mahlwerk/insights.py, used by the mock API and by the card. Pure, no DOM: tested by tests/training.test.mjs.
// A week runs Monday to Sunday; a training day is a day whose workouts add up to at least TRAINING_MIN_MINUTES.
// Only regularity counts: nothing here looks at kcal, pace or distance.
import type { InsightTraining, InsightTrainingGroup, WeekProgress } from './types';

export const TRAINING_MIN_MINUTES = 10;
export const TRAINING_MIN_DAYS = 5;
export const MAX_WORKOUTS_WEEK = 7;

// calendar arithmetic on "YYYY-MM-DD" in UTC (no time zone or summer time involved); no imports besides types, so node can test it
const ms = (day: string) => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const shiftDay = (day: string, n: number) => iso(ms(day) + n * 86400000);
const daysBetween = (a: string, b: string) => Math.round((ms(b) - ms(a)) / 86400000);
/** Monday of the week a day belongs to. */
export const weekStart = (day: string) => shiftDay(day, -((new Date(ms(day)).getUTCDay() + 6) % 7));

interface Minutes { day: string; minutes: number }

/** The days whose workouts add up to at least TRAINING_MIN_MINUTES (several workouts on a day are one training day). */
export function trainingDays(workouts: Minutes[]): Set<string> {
  const sum = new Map<string, number>();
  for (const w of workouts) sum.set(w.day, (sum.get(w.day) ?? 0) + w.minutes);
  return new Set([...sum].filter(([, m]) => m >= TRAINING_MIN_MINUTES).map(([d]) => d));
}

/** A running number of the calendar week (consecutive weeks differ by 1). */
export const weekNumber = (day: string) => Math.round(daysBetween('2001-01-01', weekStart(day)) / 7);

/** Training days per calendar week, by week number. */
export function weeklyCounts(trained: Iterable<string>): Map<number, number> {
  const counts = new Map<number, number>();
  for (const d of trained) counts.set(weekNumber(d), (counts.get(weekNumber(d)) ?? 0) + 1);
  return counts;
}

/** The week of `day` against the weekly goal; null while the goal is off. Streak: consecutive weeks that reached the goal, ending
 *  with this week when it is reached already, else with the week before. */
export function weekBlock(trained: Set<string>, goal: number, day: string): WeekProgress | null {
  if (!(goal > 0)) return null;
  const monday = weekStart(day);
  const days = Array.from({ length: 7 }, (_, i) => trained.has(shiftDay(monday, i)));
  const counts = weeklyCounts(trained);
  let week = weekNumber(monday);
  if ((counts.get(week) ?? 0) < goal) week -= 1;
  let streak = 0;
  while ((counts.get(week) ?? 0) >= goal) { streak += 1; week -= 1; }
  return { goal, days, done: days.filter(Boolean).length, streak };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r1 = (v: number) => Math.round(v * 10) / 10;

/** The `training` block of GET insights for a period. `workouts` may reach beyond the period (whole calendar weeks); `loggedDays`
 *  are the days with entries; `kcalGoal` is each day's own calorie goal (null without a goal). Null without a workout in the period. */
export function trainingSummary(
  first: string, last: string, workouts: Minutes[], goal: number, loggedDays: string[],
  totals: (day: string) => { kcal: number; protein: number }, kcalGoal: (day: string) => number | null, today: string | null,
): InsightTraining | null {
  const inside = workouts.filter((w) => w.day >= first && w.day <= last);
  if (!inside.length) return null;
  const all = trainingDays(workouts);
  const counts = weeklyCounts(all);
  const weeks: InsightTraining['weeks'] = [];
  for (let monday = weekStart(first); monday <= last; monday = shiftDay(monday, 7)) {
    weeks.push({ week_start: monday, training_days: counts.get(weekNumber(monday)) ?? 0 });
  }
  const days = loggedDays.filter((d) => d !== today);
  const trained = days.filter((d) => all.has(d) && d >= first && d <= last);
  const rest = days.filter((d) => !trained.includes(d));
  const full = trained.length >= TRAINING_MIN_DAYS && rest.length >= TRAINING_MIN_DAYS;
  const group = (ds: string[]): InsightTrainingGroup => ({
    days: ds.length,
    kcal: full ? r1(mean(ds.map((d) => totals(d).kcal))) : null,
    protein: full ? r1(mean(ds.map((d) => totals(d).protein))) : null,
    kcal_vs_goal: full && ds.every((d) => kcalGoal(d) != null) ? r1(mean(ds.map((d) => totals(d).kcal - kcalGoal(d)!))) : null,
  });
  return {
    training_days: [...all].filter((d) => d >= first && d <= last).length,
    workout_minutes: r1(inside.reduce((a, w) => a + w.minutes, 0)),
    weeks, goal: goal > 0 ? goal : null, min_days: TRAINING_MIN_DAYS, trained: group(trained), rest: group(rest),
  };
}

/** Height of a week bar as a share (0..1) of the chart: the scale reaches the goal, the busiest week or 3, whichever is highest,
 *  so a bar never looks like a score and the goal line always fits. */
export function barScale(weeks: { training_days: number }[], goal: number | null): number {
  return Math.max(3, goal ?? 0, ...weeks.map((w) => w.training_days));
}
