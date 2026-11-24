// The goal over time (goals.py): a change counts from the day it was made, earlier days keep the goal they had then.
// A day is judged against the row with the latest `valid_from` on or before it; a day before the first row gets the first row.
import { dayGoalKcal } from './activity.ts';
import { pySum, roundHalfEven } from './num.ts';

export const SINCE_START = '0001-01-01';
export const KEYS = ['kcal', 'protein', 'carbs', 'fat', 'water_ml', 'steps'] as const;
const WHOLE = ['water_ml', 'steps'];

export type GoalValues = { kcal: number; protein: number; carbs: number; fat: number; water_ml: number; steps: number };
/** The goals of one user by `valid_from`, oldest first (never empty). */
export interface Timeline { days: string[]; goals: GoalValues[] }

export function makeTimeline(rows: [string, GoalValues][]): Timeline {
  if (!rows.length) throw new Error('a timeline needs at least one goal');
  const sorted = [...rows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { days: sorted.map((r) => r[0]), goals: sorted.map((r) => r[1]) };
}

export const current = (tl: Timeline): GoalValues => tl.goals.at(-1)!;

/** The goal that counted on `day` (ISO date). */
export function goalOn(tl: Timeline, day: string): GoalValues {
  let i = 0;
  while (i < tl.days.length && tl.days[i] <= day) i++; // bisect_right
  return tl.goals[Math.max(i - 1, 0)];
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

/** A plain goal (one that always counted), a Timeline or null -> Timeline or null. */
export function asTimeline(goal: Timeline | GoalValues | null | undefined): Timeline | null {
  if (goal == null) return null;
  return 'days' in goal ? goal : makeTimeline([[SINCE_START, goal]]);
}

/** The kcal goal that counts on `day`: that day's goal plus its active-energy bonus. */
export const kcalOn = (tl: Timeline | null, bonus: Record<string, number> | null, day: string): number | null =>
  tl === null ? null : dayGoalKcal(goalOn(tl, day).kcal, bonus, day);
