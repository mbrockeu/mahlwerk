// The activity of a day as the API shows it (activity_views.py; shared by the day view, the activity routes and the summary).
import * as activity from './activity.ts';
import { addDays } from './dates.ts';
import type { Db, Row } from './db.ts';
import { asTimeline, goalOn, type GoalValues, type Timeline } from './goals.ts';
import type { DayActivity, WeekProgress, Workout, WorkoutSource } from './models/activity.ts';
import { roundHalfEven } from './num.ts';
import { activityBetween, trainingDaysBetween, weightFor, workoutsBetween } from './store/activity.ts';
import { goalTimeline } from './store/goals.ts';
import { getSettings } from './store/settings.ts';

/** A stored workout; without a kcal value it is estimated from MET, body weight and minutes. */
export function workoutOut(row: Row, weightKg: number | null): Workout {
  const estimated = row.kcal === null;
  const kcal = estimated ? activity.estimateKcal(row.kind, row.minutes, weightKg) : row.kcal;
  return {
    id: row.id, day: row.day, started_at: row.started_at, kind: row.kind, name: row.name || '', minutes: row.minutes,
    kcal: roundHalfEven(kcal, 1), kcal_estimated: estimated, distance_m: row.distance_m, steps: row.steps, note: row.note,
    source: row.source,
  };
}

/** The activity of every day in the range (also those without any data), by day. `goal` (a goal timeline or plain goal,
 * default the user's timeline) gives each day its steps goal. */
export async function dayActivities(db: Db, uid: number, first: string, last: string, goal?: Timeline | GoalValues | null, settingsIn?: Record<string, unknown>): Promise<Record<string, DayActivity>> {
  const settings = settingsIn ?? await getSettings(db, uid);
  const add = activity.addToGoalOn(settings);
  const tl = goal !== undefined && goal !== null ? asTimeline(goal) : await goalTimeline(db, uid);
  const stepsGoal = (day: string): number => (tl ? goalOn(tl, day).steps : undefined) ?? activity.DEFAULT_STEPS_GOAL;

  const rows = await activityBetween(db, uid, first, last);
  const byDay = new Map<string, Row[]>();
  for (const w of await workoutsBetween(db, uid, first, last)) byDay.set(w.day, [...(byDay.get(w.day) ?? []), w]);
  const weights = new Map<string, number | null>();
  const weight = async (day: string) => {
    if (!weights.has(day)) weights.set(day, await weightFor(db, uid, day));
    return weights.get(day)!;
  };

  const weekly = activity.workoutsWeekOn(settings);
  let trained = new Set<string>();
  let counts = new Map<number, number>();
  const weeks = new Map<string, ReturnType<typeof activity.weekBlock>>(); // the week block depends on the week only
  if (weekly) {
    trained = await trainingDaysBetween(db, uid, '0000-01-01', addDays(activity.weekStart(last), 6));
    counts = activity.weeklyCounts(trained);
  }
  const weekOf = (day: string): WeekProgress | null => {
    if (!weekly) return null;
    const monday = activity.weekStart(day);
    if (!weeks.has(monday)) weeks.set(monday, activity.weekBlock(trained, weekly, day, counts));
    return weeks.get(monday)!;
  };

  const out: Record<string, DayActivity> = {};
  for (const day of activity.daysOf(first, last)) {
    const row = rows[day];
    const workouts: Workout[] = [];
    for (const w of byDay.get(day) ?? []) workouts.push(workoutOut(w, await weight(day)));
    out[day] = {
      steps: row ? row.steps : null, steps_goal: stepsGoal(day), active_kcal: row ? row.active_kcal : null,
      distance_m: row ? row.distance_m : null, source: row ? (row.source as WorkoutSource) : null,
      bonus_kcal: row ? activity.goalBonus(row.active_kcal, add) : 0, workouts, week: weekOf(day),
    };
  }
  return out;
}

/** Bonus per day for `first`..`last` (both included); empty while the setting is off, so callers can pass the result around
 * and `dayGoalKcal` simply adds nothing. */
export async function goalBonuses(db: Db, userId: number, first: string, last: string, settingsIn?: Record<string, unknown>): Promise<Record<string, number>> {
  const settings = settingsIn ?? await getSettings(db, userId);
  if (!activity.addToGoalOn(settings)) return {};
  const out: Record<string, number> = {};
  for (const [day, row] of Object.entries(await activityBetween(db, userId, first, last))) {
    const bonus = activity.goalBonus(row.active_kcal, true);
    if (bonus) out[day] = bonus;
  }
  return out;
}
