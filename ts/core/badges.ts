// Badges (badges.py): small rewards for habits (keeping at it, logging, eating in balance), never for eating less or losing
// weight. Every badge is a pure function of the person's data and returns its progress as [current, target]; it is reached
// when current >= target. Once reached it is remembered (table `badge_earned`); the only exception is a badge reached with
// demo entries alone, which goes away when the demo data is removed.
import * as activity from './activity.ts';
import { adherenceClass } from './analysis.ts';
import { toOrdinal, weekday } from './dates.ts';
import { asTimeline, goalOn, kcalOn, type GoalValues, type Timeline } from './goals.ts';
import { goalBonuses } from './activityViews.ts';
import type { Db } from './db.ts';
import { badgeInputs, badgesEarned, recordBadges, type BadgeEntry, type BadgeRow } from './store/badges.ts';
import { workoutsForBadges } from './store/workouts.ts';

const WINDOW = 7; // "x of 7 days" badges look at every run of seven consecutive calendar days
const PROTEIN_SHARE = 0.9; // protein goal reached = at least 90 % of it
const FIBER_GOAL = 25.0;
const MAIN_MEALS = ['breakfast', 'lunch', 'dinner'];

type Progress = [number, number];

/** What the badges look at, prepared once from the stored rows. */
class Data {
  days = new Map<string, { kcal: number; protein: number; fiber: number; meals: Set<string> }>();
  foods = new Set<string>();
  weightDays: Set<string>;
  recipes: number;
  goal: Timeline | null;
  trainingDays: Set<string>;
  bonus: Record<string, number>;

  constructor(entries: BadgeEntry[], weightDays: string[], recipes: number, goal: Timeline | GoalValues | null, bonus: Record<string, number>, workouts: { day: string; minutes: number | null }[]) {
    for (const e of entries) {
      let day = this.days.get(e.day);
      if (!day) this.days.set(e.day, (day = { kcal: 0.0, protein: 0.0, fiber: 0.0, meals: new Set() }));
      for (const key of ['kcal', 'protein', 'fiber'] as const) {
        const v = e.per_100[key];
        day[key] += (v == null ? null : (v * e.amount) / 100) || 0.0; // nutrition.scale for the three keys
      }
      day.meals.add(e.meal);
      this.foods.add(e.food_id !== null ? JSON.stringify(['id', e.food_id]) : JSON.stringify(['name', e.name, e.brand]));
    }
    this.weightDays = new Set(weightDays);
    this.recipes = recipes;
    this.goal = asTimeline(goal); // every day is judged against the goal of that day
    this.trainingDays = activity.trainingDays(workouts); // days with at least TRAINING_MIN_MINUTES of workouts
    this.bonus = bonus; // per day: kcal the active energy adds to the calorie goal (empty while that is off)
  }
}

const ordinals = (days: Iterable<string>): number[] => [...days].map(toOrdinal).sort((a, b) => a - b);

/** Longest stretch of consecutive numbers in a sorted list without duplicates. */
export function longestRun(nums: number[]): number {
  let best = 0, run = 0;
  nums.forEach((n, i) => {
    run = i && n === nums[i - 1] + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  });
  return best;
}

/** The most days of `days` that fall into any seven consecutive calendar days. */
export function bestWindow(days: Iterable<string>): number {
  const nums = ordinals(days);
  let best = 0, start = 0;
  nums.forEach((n, end) => {
    while (n - nums[start] >= WINDOW) start++;
    best = Math.max(best, end - start + 1);
  });
  return best;
}

const capped = (current: number, target: number): Progress => [Math.min(current, target), target];
const streak = (d: Data, target: number): Progress => capped(longestRun(ordinals(d.days.keys())), target);

const BADGES: [string, (d: Data) => Progress][] = [
  ['first_entry', (d) => capped(d.days.size, 1)],
  ['streak_3', (d) => streak(d, 3)],
  ['streak_7', (d) => streak(d, 7)],
  ['streak_30', (d) => streak(d, 30)],
  ['streak_100', (d) => streak(d, 100)],
  ['scans_10', (d) => capped(d.foods.size, 10)],
  ['scans_50', (d) => capped(d.foods.size, 50)],
  ['first_recipe', (d) => capped(d.recipes, 1)],
  // the protein goal (at least 90 % of it) on 5 of any 7 consecutive days; needs a goal
  ['protein_week', (d) => {
    if (!d.goal) return [0, 5];
    const hit = [...d.days].filter(([k, v]) => { const g = goalOn(d.goal!, k).protein; return g > 0 && v.protein >= g * PROTEIN_SHARE; }).map(([k]) => k);
    return capped(bestWindow(hit), 5);
  }],
  // calories within 90-110 % of the goal on 5 of any 7 consecutive days; needs a goal
  ['balanced_week', (d) => {
    if (!d.goal) return [0, 5];
    const hit = [...d.days].filter(([k, v]) => adherenceClass(v.kcal, kcalOn(d.goal!, d.bonus, k)!) === 'in').map(([k]) => k);
    return capped(bestWindow(hit), 5);
  }],
  ['fiber_5', (d) => capped(bestWindow([...d.days].filter(([, v]) => v.fiber >= FIBER_GOAL).map(([k]) => k)), 5)],
  // at least one weight entered in each of 4 consecutive calendar weeks (Monday to Sunday)
  ['weigh_in_4', (d) => capped(longestRun([...new Set([...d.weightDays].map((x) => Math.floor((toOrdinal(x) - weekday(x)) / 7)))].sort((a, b) => a - b)), 4)],
  ['full_day_10', (d) => capped([...d.days.values()].filter((v) => MAIN_MEALS.every((m) => v.meals.has(m))).length, 10)],
  ['first_workout', (d) => capped(d.trainingDays.size, 1)],
  ['active_week', (d) => capped(Math.max(0, ...activity.weeklyCounts(d.trainingDays).values()), 3)],
  ['active_month', (d) => capped(longestRun([...activity.weeklyCounts(d.trainingDays)].filter(([, c]) => c >= 2).map(([n]) => n).sort((a, b) => a - b)), 4)],
  ['workouts_25', (d) => capped(d.trainingDays.size, 25)],
];
export const CODES = BADGES.map(([code]) => code);

const progress = (d: Data): Record<string, Progress> => Object.fromEntries(BADGES.map(([code, fn]) => [code, fn(d)]));
const reached = (d: Data): Set<string> => new Set(Object.entries(progress(d)).filter(([, [cur, target]]) => cur >= target).map(([code]) => code));

/** Bring the remembered badges up to date and describe them: earned, still open (with progress) and new. */
export async function overview(db: Db, userId: number, goal: Timeline | GoalValues | null, now: number) {
  const [entries, weights, recipes] = await badgeInputs(db, userId);
  const bonus = await goalBonuses(db, userId, '0000-01-01', '9999-12-31');
  const workouts = await workoutsForBadges(db, userId);
  const everything = new Data(entries, weights.map((w) => w.day), recipes, goal, bonus, workouts);
  const real = new Data(entries.filter((e) => !e.demo), weights.filter((w) => !w.demo).map((w) => w.day), recipes, goal, bonus, workouts.filter((w) => !w.demo));
  await recordBadges(db, userId, reached(everything), reached(real), now);
  return describe(await badgesEarned(db, userId), progress(everything));
}

export function describe(earnedRows: BadgeRow[], current: Record<string, Progress>) {
  const earned = earnedRows.filter((r) => Object.hasOwn(current, r.code));
  const got = new Set(earned.map((r) => r.code));
  return {
    earned: earned.map((r) => ({ code: r.code, earned_at: r.earned_at, seen: Boolean(r.seen) })),
    open: Object.entries(current).filter(([code]) => !got.has(code)).map(([code, [cur, target]]) => ({ code, progress: { current: cur, target } })),
    new: earned.filter((r) => !r.seen).map((r) => r.code),
  };
}

