// The goal over time (goals.py): a change counts from the day it was made, earlier days keep the goal they had then.
// A day is judged against the row with the latest `valid_from` on or before it; a day before the first row gets the first row.
import { dayGoalKcal } from './activity.ts';
import { pySum, roundHalfEven } from './num.ts';

export const SINCE_START = '0001-01-01';
export const KEYS = ['kcal', 'protein', 'carbs', 'fat', 'water_ml', 'steps'] as const;
const WHOLE = ['water_ml', 'steps'];

export type GoalValues = { kcal: number; protein: number; carbs: number; fat: number; water_ml: number; steps: number };
/** The alternative goal of a goal change: on the weekdays in `days` (bit 0 = Monday ... bit 6 = Sunday) these kcal and macros count
 * instead of the normal ones (water and steps never differ). */
export type DaySchedule = { days: number; kcal: number; protein: number; carbs: number; fat: number };
/** The goals of one user by `valid_from`, oldest first (never empty). `schedules` (when given) runs parallel to `goals`. */
export interface Timeline { days: string[]; goals: GoalValues[]; schedules?: (DaySchedule | null)[] }

export function makeTimeline(rows: [string, GoalValues, (DaySchedule | null)?][]): Timeline {
  if (!rows.length) throw new Error('a timeline needs at least one goal');
  const sorted = [...rows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const tl: Timeline = { days: sorted.map((r) => r[0]), goals: sorted.map((r) => r[1]) };
  if (sorted.some((r) => r[2])) tl.schedules = sorted.map((r) => r[2] ?? null);
  return tl;
}

/** The normal goal that counts now (without the weekday schedule). */
export const current = (tl: Timeline): GoalValues => tl.goals.at(-1)!;
/** The weekday schedule that counts now, null without one. */
export const currentSchedule = (tl: Timeline): DaySchedule | null => tl.schedules?.at(-1) ?? null;

/** Bit of the weekday of an ISO date in a schedule mask: 0 = Monday ... 6 = Sunday (no time zone involved). */
export function weekdayBit(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d); // setUTCFullYear keeps years below 100 (SINCE_START) as they are
  return (dt.getUTCDay() + 6) % 7;
}

/** The goal that counted on `day` (ISO date): the alternative kcal and macros when the weekday is one of the schedule's. */
export function goalOn(tl: Timeline, day: string): GoalValues {
  let i = 0;
  while (i < tl.days.length && tl.days[i] <= day) i++; // bisect_right
  i = Math.max(i - 1, 0);
  const goal = tl.goals[i], alt = tl.schedules?.[i];
  if (!alt || !(alt.days & (1 << weekdayBit(day)))) return goal;
  return { ...goal, kcal: alt.kcal, protein: alt.protein, carbs: alt.carbs, fat: alt.fat };
}

/** The mean goal of `days` (one decimal for kcal and the macros, whole water and steps). Without days the goal of
 * `fallback`, without that the current one. */
export function period(tl: Timeline, days: Iterable<string>, fallback?: string): Partial<GoalValues> {
  const list = [...days];
  if (!list.length) return fallback ? goalOn(tl, fallback) : current(tl);
  const goals = list.map((d) => goalOn(tl, d));
  const out: Partial<GoalValues> = {};
  for (const key of KEYS) {
    if (goals.some((g) => g[key] == null)) continue; // a hand-made goal (tests) may lack water and steps
    const mean = pySum(goals.map((g) => g[key])) / goals.length;
    out[key] = WHOLE.includes(key) ? roundHalfEven(mean) : roundHalfEven(mean, 1);
  }
  return out;
}

export const changes = (tl: Timeline): [string, GoalValues][] => tl.days.map((d, i) => [d, tl.goals[i]]);

/** The weekday mask <-> ISO weekdays (1 = Monday ... 7 = Sunday, sorted) of the API. */
export const maskOf = (weekdays: number[]): number => weekdays.reduce((m, w) => m | (1 << (w - 1)), 0);
export const weekdaysOf = (mask: number): number[] => [1, 2, 3, 4, 5, 6, 7].filter((w) => mask & (1 << (w - 1)));

/** A plain goal (one that always counted), a Timeline or null -> Timeline or null. */
export function asTimeline(goal: Timeline | GoalValues | null | undefined): Timeline | null {
  if (goal == null) return null;
  return 'days' in goal ? goal : makeTimeline([[SINCE_START, goal]]);
}

/** The kcal goal that counts on `day`: that day's goal plus its active-energy bonus. */
export const kcalOn = (tl: Timeline | null, bonus: Record<string, number> | null, day: string): number | null =>
  tl === null ? null : dayGoalKcal(goalOn(tl, day).kcal, bonus, day);
