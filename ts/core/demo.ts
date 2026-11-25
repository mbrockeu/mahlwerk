// Demo data (demo.py): invented but plausible diary entries and weights, so the app can be tried out. The numbers are rounded
// approximations from general nutrition tables, good enough for a demo and not meant as reference data.
// Generation is deterministic per user and day (the random generator is seeded from the user id and the date, and is
// Python's own, see pyrandom.ts), so repeating a call changes nothing. Days with real entries or real weights are never touched.
import { estimateKcal } from './activity.ts';
import { addDays, daysBetween, weekday } from './dates.ts';
import type { Db } from './db.ts';
import { PER_100_KEYS, parseServing } from './nutrition.ts';
import { pySum, roundHalfEven } from './num.ts';
import { PyRandom } from './pyrandom.ts';
import { plausible } from './nutrients.ts';
import { getGoal, setGoal } from './store/goals.ts';
import { activityDays, addDemo, diaryDays, waterDays, weightDays, type DemoRows } from './store/demo.ts';
import { sleepBetween } from './store/workouts.ts';

export const DEFAULT_GOAL = { kcal: 2100, protein: 120.0, carbs: 230.0, fat: 70.0, water_ml: 2000, steps: 8000 };

// name, unit, serving, meals (b = breakfast, l = lunch, d = dinner, s = snack), typical portion range,
// per 100: kcal, fat, saturated fat, carbs, sugars, fiber, protein, salt
type Row = [string, 'g' | 'ml', string, string, [number, number], number[]];
const CATALOG: Row[] = [
  ['Haferflocken', 'g', '40 g', 'b', [40, 80], [372, 7.0, 1.2, 58.7, 1.2, 10.0, 13.5, 0.02]],
  ['Vollmilch 3,5 %', 'ml', '200 ml', 'bd', [150, 250], [65, 3.5, 2.4, 4.8, 4.8, 0.0, 3.4, 0.1]],
  ['Banane', 'g', '120 g', 'bs', [100, 150], [93, 0.3, 0.1, 20.0, 16.0, 2.0, 1.1, 0.0]],
  ['Vollkornbrot', 'g', '50 g', 'bd', [50, 110], [215, 1.2, 0.3, 40.0, 3.5, 8.0, 7.5, 1.3]],
  ['Weißbrötchen', 'g', '50 g', 'b', [50, 100], [270, 1.0, 0.2, 54.0, 3.0, 3.0, 9.0, 1.3]],
  ['Gouda', 'g', '30 g', 'bd', [20, 60], [356, 27.0, 17.5, 0.1, 0.1, 0.0, 25.0, 1.8]],
  ['Butter', 'g', '10 g', 'bd', [5, 15], [741, 82.0, 52.0, 0.6, 0.6, 0.0, 0.7, 0.02]],
  ['Frischkäse natur', 'g', '30 g', 'bd', [20, 40], [250, 23.0, 15.0, 3.0, 3.0, 0.0, 6.0, 0.7]],
  ['Putenbrust Aufschnitt', 'g', '30 g', 'bd', [20, 60], [105, 1.5, 0.5, 1.0, 1.0, 0.0, 22.0, 1.8]],
  ['Ei', 'g', '55 g', 'bd', [55, 110], [137, 9.7, 2.8, 0.7, 0.7, 0.0, 12.5, 0.4]],
  ['Joghurt natur', 'g', '150 g', 'bs', [150, 250], [66, 3.8, 2.5, 4.7, 4.7, 0.0, 3.5, 0.13]],
  ['Skyr natur', 'g', '150 g', 'bs', [150, 250], [63, 0.2, 0.1, 4.0, 4.0, 0.0, 11.0, 0.1]],
  ['Honig', 'g', '15 g', 'b', [10, 25], [306, 0.0, 0.0, 75.0, 75.0, 0.0, 0.4, 0.0]],
  ['Orangensaft', 'ml', '200 ml', 'b', [150, 250], [43, 0.2, 0.0, 9.5, 9.0, 0.2, 0.7, 0.0]],
  ['Erdnussbutter', 'g', '15 g', 'bs', [10, 25], [600, 50.0, 10.0, 10.0, 6.0, 6.0, 25.0, 1.0]],
  ['Apfel', 'g', '150 g', 'bs', [120, 200], [54, 0.2, 0.0, 11.4, 10.0, 2.0, 0.3, 0.0]],
  ['Erdbeeren', 'g', '150 g', 'bs', [100, 200], [32, 0.4, 0.0, 5.5, 5.5, 2.0, 0.7, 0.0]],
  ['Nussmischung', 'g', '30 g', 's', [20, 40], [620, 54.0, 7.0, 10.0, 5.0, 7.0, 20.0, 0.0]],
  ['Zartbitterschokolade', 'g', '25 g', 's', [15, 40], [540, 36.0, 22.0, 40.0, 30.0, 10.0, 7.0, 0.02]],
  ['Butterkekse', 'g', '25 g', 's', [15, 40], [450, 12.0, 7.0, 74.0, 20.0, 2.5, 7.0, 0.7]],
  ['Salzstangen', 'g', '30 g', 's', [20, 40], [380, 2.0, 0.4, 75.0, 3.0, 3.0, 10.0, 5.0]],
  ['Apfelschorle', 'ml', '250 ml', 'ls', [200, 400], [24, 0.0, 0.0, 5.8, 5.8, 0.0, 0.0, 0.0]],
  ['Karotte', 'g', '80 g', 'ls', [60, 150], [36, 0.2, 0.0, 7.0, 6.0, 2.8, 0.9, 0.1]],
  ['Hähnchenbrust', 'g', '150 g', 'ld', [120, 200], [150, 3.5, 0.9, 0.0, 0.0, 0.0, 30.0, 0.2]],
  ['Lachs', 'g', '150 g', 'ld', [120, 180], [202, 12.0, 2.5, 0.0, 0.0, 0.0, 22.0, 0.15]],
  ['Hackfleisch gebraten', 'g', '120 g', 'ld', [100, 150], [260, 19.0, 8.0, 0.0, 0.0, 0.0, 22.0, 0.5]],
  ['Reis gekocht', 'g', '180 g', 'ld', [150, 250], [130, 0.3, 0.1, 28.0, 0.1, 0.4, 2.7, 0.01]],
  ['Spaghetti gekocht', 'g', '220 g', 'ld', [200, 300], [158, 0.9, 0.2, 31.0, 0.6, 1.8, 5.8, 0.01]],
  ['Kartoffeln gekocht', 'g', '250 g', 'ld', [200, 350], [71, 0.1, 0.0, 14.8, 0.8, 1.7, 2.0, 0.01]],
  ['Linsen gekocht', 'g', '200 g', 'l', [150, 250], [116, 0.4, 0.1, 20.0, 1.0, 8.0, 9.0, 0.01]],
  ['Tomatensoße', 'g', '150 g', 'l', [100, 200], [55, 2.5, 0.3, 6.5, 5.5, 1.5, 1.6, 0.8]],
  ['Brokkoli gegart', 'g', '150 g', 'ld', [100, 200], [28, 0.4, 0.1, 2.4, 1.4, 3.0, 3.1, 0.02]],
  ['Paprika', 'g', '120 g', 'ld', [80, 150], [31, 0.3, 0.1, 6.0, 5.0, 2.0, 1.0, 0.01]],
  ['Tomate', 'g', '100 g', 'ld', [80, 200], [18, 0.2, 0.0, 2.6, 2.5, 1.2, 0.9, 0.01]],
  ['Gurke', 'g', '100 g', 'ld', [60, 150], [12, 0.2, 0.0, 1.8, 1.7, 0.5, 0.6, 0.01]],
  ['Blattsalat', 'g', '60 g', 'ld', [50, 100], [15, 0.2, 0.0, 1.5, 1.2, 1.5, 1.3, 0.05]],
  ['Mozzarella', 'g', '125 g', 'ld', [60, 125], [241, 17.5, 11.0, 1.0, 1.0, 0.0, 18.0, 0.6]],
  ['Hüttenkäse', 'g', '100 g', 'ld', [80, 150], [98, 4.3, 2.7, 3.3, 3.3, 0.0, 12.5, 0.8]],
  ['Olivenöl', 'ml', '10 ml', 'ld', [5, 15], [884, 100.0, 14.0, 0.0, 0.0, 0.0, 0.0, 0.0]],
];

// A few realistic micronutrients per 100 g/ml for about a third of the foods (units as in nutrients.ts), so that the
// evaluation has something to show and the coverage stays visibly below 100 %. Rounded table values.
const MICROS: Record<string, Record<string, number>> = {
  'Haferflocken': { magnesium: 129, iron: 4.3, zinc: 4.3, phosphorus: 410, potassium: 370, manganese: 4.9, vitamin_b1: 0.5, vitamin_b9: 87 },
  'Vollmilch 3,5 %': { calcium: 120, potassium: 155, phosphorus: 92, iodine: 10, vitamin_b2: 0.18, vitamin_b12: 0.4, vitamin_d: 0.1 },
  'Banane': { potassium: 360, magnesium: 27, vitamin_c: 9, vitamin_b6: 0.37, manganese: 0.27 },
  'Vollkornbrot': { magnesium: 70, iron: 2.5, zinc: 2.5, potassium: 230, vitamin_b1: 0.2, vitamin_b9: 40 },
  'Ei': { vitamin_d: 2.0, vitamin_b12: 1.9, iodine: 12, selenium: 30, vitamin_b7: 25, vitamin_a: 160, vitamin_b2: 0.4, iron: 1.9, cholesterol: 400 },
  'Skyr natur': { calcium: 120, phosphorus: 170, potassium: 150, vitamin_b12: 0.5, iodine: 4 },
  'Orangensaft': { vitamin_c: 40, potassium: 180, vitamin_b9: 30, vitamin_b1: 0.07, magnesium: 10 },
  'Nussmischung': { magnesium: 170, vitamin_e: 10, zinc: 3.0, copper: 1.2, manganese: 2.0, potassium: 700, phosphorus: 400 },
  'Karotte': { vitamin_a: 835, potassium: 320, vitamin_k: 13, vitamin_c: 6, vitamin_b6: 0.14 },
  'Lachs': { vitamin_d: 8.0, vitamin_b12: 3.5, selenium: 36, potassium: 380, omega_3: 2.0, vitamin_b6: 0.6, vitamin_b3: 8.0, iodine: 30, cholesterol: 60 },
  'Linsen gekocht': { iron: 3.3, vitamin_b9: 180, potassium: 370, magnesium: 36, zinc: 1.3, phosphorus: 180 },
  'Hähnchenbrust': { vitamin_b3: 11.0, vitamin_b6: 0.5, potassium: 330, phosphorus: 220, selenium: 14, vitamin_b12: 0.3, zinc: 0.9 },
  'Gouda': { calcium: 800, phosphorus: 500, vitamin_b12: 1.5, vitamin_a: 250, vitamin_b2: 0.3, zinc: 4.0, iodine: 20 },
  'Spaghetti gekocht': { magnesium: 18, iron: 0.5, zinc: 0.7, phosphorus: 58, selenium: 10, vitamin_b1: 0.02 },
  'Brokkoli gegart': { vitamin_c: 90, vitamin_k: 100, vitamin_b9: 110, potassium: 320, calcium: 47, vitamin_e: 0.8 },
};
for (const micros of Object.values(MICROS)) for (const [k, v] of Object.entries(micros)) if (!plausible(k, v)) throw new Error(`demo micro ${k}`);

const MEAL_CODES: Record<string, string> = { b: 'breakfast', l: 'lunch', d: 'dinner', s: 'snack' };
const SHARES: Record<string, number> = { breakfast: 0.25, lunch: 0.35, snack: 0.10, dinner: 0.30 };
const PICKS: Record<string, [number, number]> = { breakfast: [2, 3], lunch: [3, 3], snack: [1, 2], dinner: [2, 3] };

function foodData(row: Row) {
  const [name, unit, serving, , , values] = row;
  const parsed = parseServing(serving);
  return {
    name, brand: null, quantity: null, serving_size: serving, serving_quantity: parsed ? parsed[0] : null, unit,
    per_100: Object.fromEntries(PER_100_KEYS.map((k, i) => [k, values[i]])), extra: MICROS[name] ?? {}, complete: true,
  };
}

export const FOODS: Record<string, ReturnType<typeof foodData>> = Object.fromEntries(CATALOG.map((row) => [row[0], foodData(row)]));
const BY_MEAL: Record<string, Row[]> = Object.fromEntries(Object.entries(MEAL_CODES).map(([code, meal]) => [meal, CATALOG.filter((r) => r[3].includes(code))]));

const round = (x: number): number => roundHalfEven(x);
const step = (amount: number): number => Math.max(1, amount >= 40 ? round(amount / 5) * 5 : round(amount));

/** Pick foods for one meal and size the portions so that the meal lands near `kcal`. */
function meal(rng: PyRandom, mealName: string, kcal: number): [string, number][] {
  const pool = BY_MEAL[mealName];
  let picked: Row[] = [];
  for (let i = 0; i < 12; i++) {
    picked = rng.sample(pool, rng.randint(...PICKS[mealName]));
    const reach = pySum(picked.map((r) => (r[5][0] * r[4][1] * 2) / 100)); // what the largest sensible portions give
    if (reach >= kcal) break;
  }
  const base = picked.map((r) => rng.uniform(r[4][0], r[4][1]));
  const have = pySum(base.map((a, i) => (a * picked[i][5][0]) / 100));
  const factor = have ? kcal / have : 1;
  return picked.map((r, i) => [r[0], Math.min(5000, step(Math.min(Math.max(base[i] * factor, r[4][0] * 0.4), r[4][1] * 2)))]);
}

type Made = { meal: string; food: string; amount: number };

function dayEntries(rng: PyRandom, target: number, isToday: boolean): Made[] {
  const meals = isToday ? ['breakfast', 'lunch'] : ['breakfast', 'lunch', 'dinner'];
  if (!isToday && rng.random() < 0.75) meals.push('snack');
  const scaleTo = isToday ? 1.0 : 1 / pySum(meals.map((m) => SHARES[m]));
  return meals.flatMap((m) => meal(rng, m, target * SHARES[m] * scaleTo).map(([food, amount]) => ({ meal: m, food, amount })));
}

// Habit breakfasts: on about two days in five the breakfast is one of these, so the demo has foods that are eaten together
const HABITS: [string, number][][] = [
  [['Haferflocken', 50], ['Joghurt natur', 200], ['Erdbeeren', 120]],
  [['Vollkornbrot', 80], ['Butter', 10], ['Gouda', 40]],
];

/** Swap the generated breakfast for a habit one on some days (own random generator: the rest of the demo stays as it was). */
function habitBreakfast(rng: PyRandom, entries: Made[]): Made[] {
  if (rng.random() >= 0.4) return entries;
  const habit = HABITS[rng.randrange(HABITS.length)];
  return [...habit.map(([food, amount]) => ({ meal: 'breakfast', food, amount })), ...entries.filter((e) => e.meal !== 'breakfast')];
}

// Demo workouts: a kind with its usual minutes range and kilometres per hour (null: no distance)
const WORKOUTS: [string, [number, number], number | null][] = [
  ['running', [25, 55], 9.5], ['cycling', [40, 110], 18.0], ['walking', [30, 70], 5.0], ['strength', [35, 65], null],
  ['swimming', [25, 50], 2.0], ['yoga', [30, 60], null], ['hiking', [90, 180], 4.5], ['crosstrainer', [25, 45], null],
];

/** The weekdays (Monday = 0) with a workout in the week starting at `monday`: two to four of them. */
async function trainingWeekdays(userId: number, monday: string): Promise<Set<number>> {
  const rng = await PyRandom.seeded(`mahlwerk-demo:${userId}:training-week:${monday}`);
  const n = rng.randint(2, 4);
  return new Set(rng.sample([0, 1, 2, 3, 4, 5, 6], n));
}

type DemoWorkout = { kind: string; minutes: number; started_at: number; kcal: number; distance_m: number | null; steps: number | null };

/** Steps, active energy and, when `trains`, one workout of a demo day. */
function activityDay(rng: PyRandom, isToday: boolean, wd: number, weight: number, trains: boolean) {
  let steps = round(rng.gauss(wd < 5 ? 8600 : 10200, 2400));
  steps = Math.max(1800, Math.min(steps, 22000));
  const workouts: DemoWorkout[] = [];
  if (trains && !isToday) {
    const [kind, [low, high], speed] = WORKOUTS[rng.randrange(WORKOUTS.length)];
    const minutes = round(rng.uniform(low, high) / 5) * 5;
    const hour = rng.choice([6, 7, 12, 17, 18, 19]);
    const startedAt = hour * 3600 + rng.randrange(0, 3600, 300); // shifted to the day below
    const kcal = round(estimateKcal(kind, minutes, weight) * rng.uniform(0.85, 1.1));
    workouts.push({
      kind, minutes, started_at: startedAt, kcal,
      distance_m: speed ? round(((((speed * minutes) / 60) * 1000) / 10)) * 10 : null,
      steps: ['running', 'walking', 'hiking'].includes(kind) ? round(minutes * 150) : null,
    });
  }
  if (isToday) steps = round(steps * rng.uniform(0.2, 0.5)); // the day is still young
  const energy = round(steps * 0.04 + pySum(workouts.map((w) => w.kcal)) + rng.uniform(40, 110));
  return { day: { steps, active_kcal: energy, distance_m: round((steps * 0.74) / 10) * 10 }, workouts };
}

/** Minutes asleep before a demo day: 5.5 to 8.5 hours, mostly around seven. */
const sleepMinutes = (rng: PyRandom): number => round(Math.max(330, Math.min(510, rng.gauss(420, 55))) / 5) * 5;

const rngFor = (userId: number, day: string, kind: string): Promise<PyRandom> => PyRandom.seeded(`mahlwerk-demo:${userId}:${kind}:${day}`);

/** The unix time of local midnight at the start of `day`. */
const midnightOf = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(0);
  t.setFullYear(y, m - 1, d);
  t.setHours(0, 0, 0, 0);
  return Math.floor(t.getTime() / 1000);
};

/** Fill the last `days` days up to `today`. Returns the number of new rows and whether a goal was set. `marker` says which kind of
 * demo food the entries refer to (see store/demo.ts). */
export async function generate(db: Db, userId: number, today: string, days: number, now: number, marker = 'demo') {
  const first = addDays(today, -(days - 1));
  const [realDays, demoDays] = await diaryDays(db, userId, first, today);
  const weighed = await weightDays(db, userId, first, today);
  const watered = await waterDays(db, userId, first, today);
  const [activeDays, workoutDays] = await activityDays(db, userId, first, today);
  const sleptDays = await sleepBetween(db, userId, first, today);

  const saved = await getGoal(db, userId);
  const goalSet = saved === null;
  const goal = saved ?? DEFAULT_GOAL;

  const rows: DemoRows = { entries: [], weights: [], water: [], activity: [], workouts: [], sleep: [] };
  const startKg = 74 + ((userId * 7) % 12);
  for (let offset = 0; offset < days; offset++) {
    const iso = addDays(first, offset);
    const isToday = iso === today;
    const slept = sleepMinutes(await rngFor(userId, iso, 'sleep'));
    if (!Object.hasOwn(sleptDays, iso)) rows.sleep.push({ day: iso, minutes: slept });
    if (!realDays.has(iso) && !demoDays.has(iso)) {
      const rng = await rngFor(userId, iso, 'diary');
      if (isToday || rng.random() >= 1 / 12) { // about every twelfth day stays empty
        const [low, high] = weekday(iso) >= 5 ? [-0.08, 0.15] : [-0.15, 0.10];
        let target = goal.kcal * (1 + rng.uniform(low, high));
        if (slept < 360) target *= 1.12; // after a short night people tend to eat more
        const made = habitBreakfast(await rngFor(userId, iso, 'habit'), dayEntries(rng, target, isToday));
        rows.entries.push(...made.map((e) => ({ day: iso, ...e })));
      }
    }
    if (!weighed.has(iso)) {
      const rng = await rngFor(userId, iso, 'weight');
      if (rng.random() < 5 / 7) {
        const kg = startKg + 0.035 * daysBetween(iso, today) + rng.uniform(-0.4, 0.4);
        rows.weights.push({ day: iso, kg: roundHalfEven(kg, 1) });
      }
    }
    if (!watered.has(iso)) {
      const rng = await rngFor(userId, iso, 'water');
      if (isToday) rows.water.push({ day: iso, ml: rng.randint(1, 4) * 250 }); // the day is still young
      else if (rng.random() >= 1 / 10) rows.water.push({ day: iso, ml: rng.randint(5, 11) * 250 });
    }
    if (!activeDays.has(iso)) {
      const rng = await rngFor(userId, iso, 'activity');
      const weight = startKg + 0.035 * daysBetween(iso, today);
      const wd = weekday(iso);
      const trains = (await trainingWeekdays(userId, addDays(iso, -wd))).has(wd);
      const made = activityDay(rng, isToday, wd, weight, trains);
      rows.activity.push({ day: iso, ...made.day });
      if (!workoutDays.has(iso)) {
        const midnight = midnightOf(iso);
        rows.workouts.push(...made.workouts.map((w) => ({ day: iso, ...w, started_at: midnight + w.started_at })));
      }
    }
  }

  if (!Object.values(rows).some((r) => r.length)) {
    return { entries: 0, weights: 0, water: 0, activity: 0, workouts: 0, sleep: 0, foods: 0, goal_set: false };
  }
  if (goalSet) await setGoal(db, userId, DEFAULT_GOAL, today, now);
  return { ...(await addDemo(db, userId, FOODS, rows, marker, now)), goal_set: goalSet };
}
