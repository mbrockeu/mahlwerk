// Demo data (demo.py): invented but plausible diary entries and weights, so the app can be tried out. Deterministic per user and day
// (the random generator is seeded from the user id and the date), so repeating a call changes nothing. Days with real entries or
// real weights are never touched.
//
// NOT identical to the Python numbers: Python seeds the Mersenne Twister with the text, here a small generator (sfc32, seeded by a
// text hash) does the same job. What a given day gets differs from the Python server, but a day that is there stays as it is (rows
// are only added for days that have none), so switching servers back and forth is harmless.
import { estimateKcal } from './activity.ts';
import { dayToDate, addDays, dateToDay, weekday } from './dates.ts';
import type { Db } from './db.ts';
import { CATALOG, MICROS } from './demoData.ts';
import { PER_100_KEYS, parseServing } from './nutrition.ts';
import { roundHalfEven } from './num.ts';
import { plausible } from './nutrients.ts';
import { getGoal } from './store/goals.ts';
import { activityDays, addDemo, diaryDays, setDemoGoal, sleepBetween, waterDays, weightDays, type DemoFood } from './store/demo.ts';

export const DEFAULT_GOAL = { kcal: 2100, protein: 120.0, carbs: 230.0, fat: 70.0 };

type Row = (typeof CATALOG)[number];

/** random.Random as far as the demo needs it. */
export class Rng {
  private a: number; private b: number; private c: number; private d: number;
  private spare: number | null = null;

  constructor(seed: string) {
    // cyrb128 text hash
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0; i < seed.length; i++) {
      const k = seed.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067); h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213); h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067); h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213); h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    this.a = (h1 ^ h2 ^ h3 ^ h4) >>> 0; this.b = (h2 ^ h1) >>> 0; this.c = (h3 ^ h1) >>> 0; this.d = (h4 ^ h1) >>> 0;
    for (let i = 0; i < 12; i++) this.random();
  }

  /** [0, 1) */
  random(): number {
    this.a >>>= 0; this.b >>>= 0; this.c >>>= 0; this.d >>>= 0;
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }
  randrange(n: number): number { return Math.floor(this.random() * n); }
  /** both ends included */
  randint(a: number, b: number): number { return a + this.randrange(b - a + 1); }
  uniform(a: number, b: number): number { return a + (b - a) * this.random(); }
  choice<T>(items: readonly T[]): T { return items[this.randrange(items.length)]!; }
  sample<T>(items: readonly T[], k: number): T[] {
    const pool = [...items];
    const out: T[] = [];
    for (let i = 0; i < k; i++) out.push(pool.splice(this.randrange(pool.length), 1)[0]!);
    return out;
  }
  gauss(mu: number, sigma: number): number {
    if (this.spare !== null) { const z = this.spare; this.spare = null; return mu + z * sigma; }
    const x2pi = this.random() * 2 * Math.PI;
    const g2rad = Math.sqrt(-2 * Math.log(1 - this.random()));
    this.spare = Math.sin(x2pi) * g2rad;
    return mu + Math.cos(x2pi) * g2rad * sigma;
  }
}

const foodData = (row: Row): DemoFood => {
  const [name, unit, serving, , , values] = row;
  const parsed = parseServing(serving);
  return {
    name, brand: null, quantity: null, serving_size: serving, serving_quantity: parsed ? parsed[0] : null, unit,
    per_100: Object.fromEntries(PER_100_KEYS.map((k, i) => [k, values[i]!])), extra: MICROS[name] ?? {}, complete: true,
  };
};
for (const micros of Object.values(MICROS)) for (const [k, v] of Object.entries(micros)) if (!plausible(k, v)) throw new Error(`implausible demo value ${k}`);

export const FOODS: Record<string, DemoFood> = Object.fromEntries(CATALOG.map((r) => [r[0], foodData(r)]));
const MEAL_CODES: Record<string, string> = { b: 'breakfast', l: 'lunch', d: 'dinner', s: 'snack' };
const SHARES: Record<string, number> = { breakfast: 0.25, lunch: 0.35, snack: 0.10, dinner: 0.30 };
const PICKS: Record<string, [number, number]> = { breakfast: [2, 3], lunch: [3, 3], snack: [1, 2], dinner: [2, 3] };
const BY_MEAL: Record<string, Row[]> = Object.fromEntries(Object.entries(MEAL_CODES).map(([code, meal]) => [meal, CATALOG.filter((r) => r[3].includes(code))]));

const step = (amount: number): number => Math.max(1, amount >= 40 ? roundHalfEven(amount / 5) * 5 : roundHalfEven(amount));

/** Pick foods for one meal and size the portions so that the meal lands near `kcal`. */
function meal(rng: Rng, name: string, kcal: number): [string, number][] {
  const pool = BY_MEAL[name]!;
  let picked: Row[] = [];
  for (let i = 0; i < 12; i++) {
    picked = rng.sample(pool, rng.randint(...PICKS[name]!));
    const reach = picked.reduce((s, r) => s + (r[5][0]! * r[4][1] * 2) / 100, 0); // what the largest sensible portions give
    if (reach >= kcal) break;
  }
  const base = picked.map((r) => rng.uniform(...r[4]));
  const have = base.reduce((s, a, i) => s + (a * picked[i]![5][0]!) / 100, 0);
  const factor = have ? kcal / have : 1;
  return picked.map((r, i) => [r[0], Math.min(5000, step(Math.min(Math.max(base[i]! * factor, r[4][0] * 0.4), r[4][1] * 2)))]);
}

interface DemoEntry { meal: string; food: string; amount: number }

function dayEntries(rng: Rng, target: number, isToday: boolean): DemoEntry[] {
  const meals = isToday ? ['breakfast', 'lunch'] : ['breakfast', 'lunch', 'dinner'];
  if (!isToday && rng.random() < 0.75) meals.push('snack');
  const scaleTo = isToday ? 1.0 : 1 / meals.reduce((s, m) => s + SHARES[m]!, 0);
  return meals.flatMap((m) => meal(rng, m, target * SHARES[m]! * scaleTo).map(([food, amount]) => ({ meal: m, food, amount })));
}

// Habit breakfasts: on about two days in five the breakfast is one of these (the "Combos" of the add sheet)
const HABITS: [string, number][][] = [
  [['Haferflocken', 50], ['Joghurt natur', 200], ['Erdbeeren', 120]],
  [['Vollkornbrot', 80], ['Butter', 10], ['Gouda', 40]],
];

function habitBreakfast(rng: Rng, entries: DemoEntry[]): DemoEntry[] {
  if (rng.random() >= 0.4) return entries;
  const habit = HABITS[rng.randrange(HABITS.length)]!;
  const others = entries.filter((e) => e.meal !== 'breakfast');
  return [...habit.map(([food, amount]) => ({ meal: 'breakfast', food, amount })), ...others];
}

// Demo workouts: a kind with its usual minutes range and kilometres per hour (null: no distance)
const WORKOUTS: [string, [number, number], number | null][] = [
  ['running', [25, 55], 9.5], ['cycling', [40, 110], 18.0], ['walking', [30, 70], 5.0], ['strength', [35, 65], null],
  ['swimming', [25, 50], 2.0], ['yoga', [30, 60], null], ['hiking', [90, 180], 4.5], ['crosstrainer', [25, 45], null],
];

/** The weekdays (Monday = 0) with a workout in the week starting at `monday`: two to four of them. */
function trainingWeekdays(userId: number, monday: string): Set<number> {
  const rng = new Rng(`mahlwerk-demo:${userId}:training-week:${monday}`);
  return new Set(rng.sample([0, 1, 2, 3, 4, 5, 6], rng.randint(2, 4)));
}

function activityDay(rng: Rng, isToday: boolean, wday: number, weight: number, trains: boolean) {
  let steps = roundHalfEven(rng.gauss(wday < 5 ? 8600 : 10200, 2400));
  steps = Math.max(1800, Math.min(steps, 22000));
  const workouts: Record<string, any>[] = [];
  if (trains && !isToday) {
    const [kind, [low, high], speed] = rng.choice(WORKOUTS);
    const minutes = roundHalfEven(rng.uniform(low, high) / 5) * 5;
    const hour = rng.choice([6, 7, 12, 17, 18, 19]);
    workouts.push({
      kind, minutes: minutes, started_at: hour * 3600 + rng.randrange(12) * 300, // shifted to the day below
      kcal: roundHalfEven(estimateKcal(kind, minutes, weight) * rng.uniform(0.85, 1.1)),
      distance_m: speed ? roundHalfEven(((speed * minutes) / 60) * 1000 / 10) * 10 : null,
      steps: ['running', 'walking', 'hiking'].includes(kind) ? roundHalfEven(minutes * 150) : null,
    });
  }
  if (isToday) steps = roundHalfEven(steps * rng.uniform(0.2, 0.5)); // the day is still young
  const energy = roundHalfEven(steps * 0.04 + workouts.reduce((s, w) => s + w.kcal, 0) + rng.uniform(40, 110));
  return { day: { steps, active_kcal: energy, distance_m: roundHalfEven((steps * 0.74) / 10) * 10 }, workouts };
}

/** Minutes asleep before a demo day: 5.5 to 8.5 hours, mostly around seven. */
const sleepMinutes = (rng: Rng): number => roundHalfEven(Math.max(330, Math.min(510, rng.gauss(420, 55))) / 5) * 5;

const rngFor = (userId: number, day: string, kind: string) => new Rng(`mahlwerk-demo:${userId}:${kind}:${day}`);

/** Local midnight of `day` as unix seconds (datetime(y, m, d).timestamp()). */
const localMidnight = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const t = new Date(2000, m - 1, d);
  t.setFullYear(y);
  return Math.floor(t.getTime() / 1000);
};

/** Fill the last `days` days up to `today`. Returns the number of new rows and whether a goal was set. `marker` says which kind of
 * demo food the entries refer to. */
export async function generate(db: Db, userId: number, today: string, days: number, marker = 'demo') {
  const first = addDays(today, -(days - 1));
  const [realDays, demoDays] = await diaryDays(db, userId, first, today);
  const weighed = await weightDays(db, userId, first, today);
  const watered = await waterDays(db, userId, first, today);
  const [activeDays, workoutDays] = await activityDays(db, userId, first, today);
  const sleptDays = await sleepBetween(db, userId, first, today);
  let goal: { kcal: number } | null = await getGoal(db, userId);
  const goalSet = goal === null;
  if (goalSet) goal = DEFAULT_GOAL;

  const entries: { day: string; meal: string; food: string; amount: number }[] = [];
  const weights: { day: string; kg: number }[] = [];
  const water: { day: string; ml: number }[] = [];
  const activity: { day: string; steps: number; active_kcal: number; distance_m: number }[] = [];
  const workouts: Record<string, any>[] = [];
  const sleep: { day: string; minutes: number }[] = [];
  const startKg = 74 + ((userId * 7) % 12);
  for (let offset = 0; offset < days; offset++) {
    const iso = addDays(first, offset);
    const wday = weekday(iso);
    const isToday = iso === today;
    const slept = sleepMinutes(rngFor(userId, iso, 'sleep'));
    if (!(iso in sleptDays)) sleep.push({ day: iso, minutes: slept });
    if (!realDays.has(iso) && !demoDays.has(iso)) {
      const rng = rngFor(userId, iso, 'diary');
      if (isToday || rng.random() >= 1 / 12) { // about every twelfth day stays empty
        const [low, high] = wday >= 5 ? [-0.08, 0.15] : [-0.15, 0.10];
        let target = goal!.kcal * (1 + rng.uniform(low, high));
        if (slept < 360) target *= 1.12; // after a short night people tend to eat more
        for (const e of habitBreakfast(rngFor(userId, iso, 'habit'), dayEntries(rng, target, isToday))) entries.push({ day: iso, ...e });
      }
    }
    const daysAgo = (dayToDate(today)!.getTime() - dayToDate(iso)!.getTime()) / 86_400_000;
    if (!weighed.has(iso)) {
      const rng = rngFor(userId, iso, 'weight');
      if (rng.random() < 5 / 7) weights.push({ day: iso, kg: roundHalfEven(startKg + 0.035 * daysAgo + rng.uniform(-0.4, 0.4), 1) });
    }
    if (!watered.has(iso)) {
      const rng = rngFor(userId, iso, 'water');
      if (isToday) water.push({ day: iso, ml: rng.randint(1, 4) * 250 }); // the day is still young
      else if (rng.random() >= 1 / 10) water.push({ day: iso, ml: rng.randint(5, 11) * 250 });
    }
    if (!activeDays.has(iso)) {
      const rng = rngFor(userId, iso, 'activity');
      const weight = startKg + 0.035 * daysAgo;
      const monday = addDays(iso, -wday);
      const { day: dayActivity, workouts: dayWorkouts } = activityDay(rng, isToday, wday, weight, trainingWeekdays(userId, monday).has(wday));
      activity.push({ day: iso, ...dayActivity });
      if (!workoutDays.has(iso)) {
        const midnight = localMidnight(iso);
        for (const w of dayWorkouts) workouts.push({ day: iso, ...w, started_at: midnight + w.started_at });
      }
    }
  }
  if (!(entries.length || weights.length || water.length || activity.length || workouts.length || sleep.length)) {
    return { entries: 0, weights: 0, water: 0, activity: 0, workouts: 0, sleep: 0, foods: 0, goal_set: false };
  }
  if (goalSet) await setDemoGoal(db, userId, DEFAULT_GOAL, today);
  return { ...(await addDemo(db, userId, FOODS, entries, weights, water, activity, workouts, sleep, marker)), goal_set: goalSet };
}

void dateToDay;
