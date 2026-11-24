// Activity: steps, active energy and workouts (activity.py) – everything that is a rule rather than storage:
// the directory of workout kinds, the kcal estimate of a workout, the ONE place that decides the kcal goal of a day
// (`dayGoalKcal`) and the training rhythm (calendar weeks Monday to Sunday, training days, weekly goal).
import { addDays, dayToDate, toOrdinal, weekday } from './dates.ts';
import { roundHalfEven } from './num.ts';

export const DEFAULT_STEPS_GOAL = 8000;
export const STEPS_GOAL_RANGE = [1000, 50000] as const;
export const DEFAULT_WEIGHT_KG = 75.0; // used for the estimate when the user has never entered a weight

export const MAX_STEPS = 200_000;
export const MAX_ACTIVE_KCAL = 20_000;
export const MAX_DISTANCE_M = 500_000;
export const MAX_MINUTES = 1440;
export const MAX_WORKOUT_KCAL = 20_000;

export const TRAINING_MIN_MINUTES = 10; // a day with workouts of at least this many minutes in total is a training day
export const MAX_WORKOUTS_WEEK = 7;

export const SOURCES = ['manual', 'health', 'yazio', 'demo'] as const;

/** Metabolic equivalent: kcal per kg of body weight per hour (Compendium of Physical Activities, rounded). */
export interface Kind { key: string; met: number; icon: string }

export const KINDS: Record<string, Kind> = Object.fromEntries(([
  ['walking', 3.5, 'walk'], ['running', 9.8, 'run'], ['cycling', 7.5, 'bike'], ['hiking', 6.0, 'mountain'],
  ['swimming', 6.0, 'swim'], ['strength', 5.0, 'dumbbell'], ['yoga', 2.5, 'lotus'], ['pilates', 3.0, 'lotus'],
  ['crosstrainer', 5.0, 'bolt'], ['stairs', 8.8, 'stairs'], ['circuit', 8.0, 'bolt'], ['squash', 7.3, 'ball'],
  ['bowling', 3.0, 'ball'], ['dancing', 5.0, 'music'], ['football', 7.0, 'ball'], ['tennis', 7.3, 'ball'],
  ['skiing', 7.0, 'mountain'], ['rowing', 7.0, 'swim'], ['other', 4.0, 'bolt'],
] as const).map(([key, met, icon]) => [key, { key, met, icon }]));

// Names other systems use, compared in lower case without spaces, dashes and underscores.
const ALIASES: Record<string, string> = {
  strengthtraining: 'strength', traditionalstrengthtraining: 'strength', functionalstrengthtraining: 'strength',
  stairclimbing: 'stairs', stairstepper: 'stairs', stairs: 'stairs',
  circuittrainingcardio: 'circuit', circuittraining: 'circuit', highintensityintervaltraining: 'circuit',
  elliptical: 'crosstrainer', ellipticaltrainer: 'crosstrainer',
  dance: 'dancing', socialdance: 'dancing', soccer: 'football',
  downhillskiing: 'skiing', crosscountryskiing: 'skiing', skiing: 'skiing',
  indoorrowing: 'rowing', rower: 'rowing',
  bike: 'cycling', biking: 'cycling', outdoorcycling: 'cycling', indoorcycling: 'cycling',
  walk: 'walking', outdoorwalk: 'walking', outdoorrun: 'running', run: 'running', jogging: 'running',
  hike: 'hiking', swim: 'swimming', poolswim: 'swimming', openwaterswim: 'swimming',
};

const norm = (text: string): string => [...text.toLowerCase()].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join('');
const has = (o: object, k: string) => Object.hasOwn(o, k);

/** [key, name] for a workout described by a kind and/or a free name: a key of `KINDS` or a known alias wins, then the name
 * is tried the same way. Anything unknown becomes `other` and keeps the text that was given as its name. */
export function resolveKind(kind: string | null | undefined, name?: string | null): [string, string] {
  const given = [...(name ?? '').trim()].slice(0, 100).join('');
  for (const text of [kind, name]) {
    if (text) {
      const n = norm(text);
      const key = has(KINDS, n) ? n : has(ALIASES, n) ? ALIASES[n] : undefined;
      if (key) return [key, given];
    }
  }
  return ['other', given || [...(kind ?? '').trim()].slice(0, 100).join('')];
}

/** MET x body weight (kg) x hours. */
export const estimateKcal = (kind: string, minutes: number, weightKg: number | null | undefined): number =>
  ((has(KINDS, kind) ? KINDS[kind] : KINDS.other).met * (weightKg || DEFAULT_WEIGHT_KG) * minutes) / 60;

// the one rule for the day's goal -------------------------------------------------------------------------------

/** The kcal that the active energy adds to the day's goal: 0 unless the setting is on. */
export const goalBonus = (activeKcal: number | null | undefined, addToGoal: boolean): number =>
  addToGoal && activeKcal && activeKcal > 0 ? roundHalfEven(activeKcal) : 0;

/** The kcal goal that counts on `day`: the calorie goal plus that day's bonus (see `goalBonuses`). null without a goal. */
export const dayGoalKcal = (goalKcal: number | null, bonus: Record<string, number> | null | undefined, day: string): number | null =>
  goalKcal === null ? null : goalKcal + (bonus?.[day] ?? 0);

/** The user setting `activity.add_to_goal`, from the settings object. */
export function addToGoalOn(settings: Record<string, unknown>): boolean {
  const v = settings.activity;
  return typeof v === 'object' && v !== null && Boolean((v as any).add_to_goal);
}

// the training rhythm ---------------------------------------------------------------------------------------------

/** The Monday of the calendar week that `day` belongs to. */
export const weekStart = (day: string): string => addDays(day, -weekday(day));

/** A running number of the calendar week (consecutive weeks differ by 1), for runs of weeks. */
export const weekNumber = (day: string): number => Math.floor(toOrdinal(weekStart(day)) / 7);

/** The days whose workouts (rows with `day` and `minutes`) add up to at least TRAINING_MIN_MINUTES. */
export function trainingDays(workouts: { day: string; minutes: number | null }[]): Set<string> {
  const minutes = new Map<string, number>();
  for (const w of workouts) minutes.set(w.day, (minutes.get(w.day) ?? 0) + (w.minutes || 0));
  return new Set([...minutes].filter(([, m]) => m >= TRAINING_MIN_MINUTES).map(([d]) => d));
}

/** Training days per calendar week (by `weekNumber`). */
export function weeklyCounts(trained: Iterable<string>): Map<number, number> {
  const counts = new Map<number, number>();
  for (const day of trained) counts.set(weekNumber(day), (counts.get(weekNumber(day)) ?? 0) + 1);
  return counts;
}

/** The week of `day` against the weekly goal: `{goal, days, done, streak}`, null while the goal is off (0). `days` are
 * seven booleans Monday to Sunday, `streak` the number of consecutive weeks that reached the goal, ending with this
 * week when it is reached already, else with the week before. */
export function weekBlock(trained: Set<string>, goal: number, day: string, counts?: Map<number, number>) {
  if (goal <= 0) return null;
  const monday = weekStart(day);
  const days = Array.from({ length: 7 }, (_, i) => trained.has(addDays(monday, i)));
  const c = counts ?? weeklyCounts(trained);
  let week = weekNumber(monday);
  if ((c.get(week) ?? 0) < goal) week -= 1;
  let streak = 0;
  while ((c.get(week) ?? 0) >= goal) { streak++; week -= 1; }
  return { goal, days, done: days.filter(Boolean).length, streak };
}

/** The weekly training goal of the user settings (0 = off). */
export function workoutsWeekOn(settings: Record<string, unknown>): number {
  const v = settings.activity;
  const n = typeof v === 'object' && v !== null ? (v as any).workouts_week : 0;
  return Number.isInteger(n) && n > 0 && n <= MAX_WORKOUTS_WEEK ? n : 0;
}

/** The days of a range, `first` to `last` both included. */
export function daysOf(first: string, last: string): string[] {
  const out: string[] = [];
  for (let d = dayToDate(first)!, end = dayToDate(last)!; d <= end; d = new Date(d.getTime() + 86_400_000)) out.push(d.toISOString().slice(0, 10));
  return out;
}
