// Demo data rows (db.py: demo_counts, activity_days, diary_days, weight_days, water_days, add_demo, remove_demo).
import type { Db } from '../db.ts';
import { toJson } from '../db.ts';

export const DEMO_FOOD = "json_extract(data, '$.demo') = 1";
export const DEMO_ACCOUNT_FOOD = "json_extract(data, '$.demo_account') = 1";
/** The only values `marker` may take (they go into SQL text). */
const FOOD_MARKERS: Record<string, string> = { demo: DEMO_FOOD, demo_account: DEMO_ACCOUNT_FOOD };

const count = async (db: Db, table: string, userId: number): Promise<number> =>
  (await db.get(`SELECT count(*) AS n FROM ${table} WHERE user_id = ? AND demo = 1`, [userId]))!.n;

export async function demoCounts(db: Db, userId: number) {
  return {
    entries: await count(db, 'diary_entry', userId), weights: await count(db, 'weight', userId), water: await count(db, 'water', userId),
    activity: await count(db, 'activity_day', userId), workouts: await count(db, 'workout', userId),
  };
}

const daySet = async (db: Db, sql: string, params: (string | number)[]): Promise<Set<string>> => new Set((await db.all(sql, params)).map((r) => r.day));

/** Days in the range that have an activity row, and days that have a workout. */
export async function activityDays(db: Db, userId: number, first: string, last: string): Promise<[Set<string>, Set<string>]> {
  return [
    await daySet(db, 'SELECT day FROM activity_day WHERE user_id = ? AND day BETWEEN ? AND ?', [userId, first, last]),
    await daySet(db, 'SELECT DISTINCT day FROM workout WHERE user_id = ? AND day BETWEEN ? AND ?', [userId, first, last]),
  ];
}

/** Days in the range with real entries and days with demo entries. */
export async function diaryDays(db: Db, userId: number, first: string, last: string): Promise<[Set<string>, Set<string>]> {
  const rows = await db.all('SELECT DISTINCT day, demo FROM diary_entry WHERE user_id = ? AND day BETWEEN ? AND ?', [userId, first, last]);
  return [new Set(rows.filter((r) => !r.demo).map((r) => r.day)), new Set(rows.filter((r) => r.demo).map((r) => r.day))];
}

export const weightDays = (db: Db, userId: number, first: string, last: string) => daySet(db, 'SELECT day FROM weight WHERE user_id = ? AND day BETWEEN ? AND ?', [userId, first, last]);
export const waterDays = (db: Db, userId: number, first: string, last: string) => daySet(db, 'SELECT day FROM water WHERE user_id = ? AND day BETWEEN ? AND ?', [userId, first, last]);

export interface DemoRows {
  entries: { day: string; meal: string; food: string; amount: number }[];
  weights: { day: string; kg: number }[];
  water: { day: string; ml: number }[];
  activity: { day: string; steps: number; active_kcal: number; distance_m: number }[];
  workouts: { day: string; started_at: number; kind: string; minutes: number; kcal: number; distance_m: number | null; steps: number | null }[];
  sleep: { day: string; minutes: number }[];
}

/** Insert demo entries, weights and the rest in one transaction. `foods` maps a name to the food data; a demo food of that
 * name is reused, otherwise created. `marker` says which kind of demo food is meant ("demo" or "demo_account"). */
export async function addDemo(db: Db, userId: number, foods: Record<string, any>, rows: DemoRows, marker: string, now: number) {
  const where = FOOD_MARKERS[marker];
  const ids = new Map<string, number>();
  let created = 0;
  await db.tx(async (con) => {
    const known = new Map((await con.all(`SELECT id, data FROM food WHERE ${where}`)).map((r) => [JSON.parse(r.data).name as string, r.id as number]));
    for (const name of new Set(rows.entries.map((e) => e.food))) {
      if (known.has(name)) { ids.set(name, known.get(name)!); continue; }
      const r = await con.run("INSERT INTO food (code, source, found, data, fetched_at) VALUES (NULL, 'own', 1, ?, ?)", [toJson({ ...foods[name], [marker]: true }), now]);
      ids.set(name, r.lastId);
      created++;
    }
    for (const e of rows.entries) {
      const data = foods[e.food];
      await con.run('INSERT INTO diary_entry (user_id, day, meal, food_id, amount, unit, name, brand, per_100, extra, created_at, demo) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1)',
        [userId, e.day, e.meal, ids.get(e.food)!, e.amount, data.unit, data.name, toJson(data.per_100), toJson(data.extra || {}), now]);
    }
    for (const w of rows.weights) await con.run('INSERT OR IGNORE INTO weight (user_id, day, kg, demo) VALUES (?, ?, ?, 1)', [userId, w.day, w.kg]);
    for (const w of rows.water) await con.run('INSERT OR IGNORE INTO water (user_id, day, ml, demo) VALUES (?, ?, ?, 1)', [userId, w.day, w.ml]);
    for (const a of rows.activity) {
      await con.run("INSERT OR IGNORE INTO activity_day (user_id, day, steps, active_kcal, distance_m, source, demo) VALUES (?, ?, ?, ?, ?, 'demo', 1)", [userId, a.day, a.steps, a.active_kcal, a.distance_m]);
    }
    for (const s of rows.sleep) await con.run("INSERT OR IGNORE INTO sleep_day (user_id, day, minutes, source, demo) VALUES (?, ?, ?, 'demo', 1)", [userId, s.day, s.minutes]);
    for (const w of rows.workouts) {
      await con.run("INSERT INTO workout (user_id, day, started_at, kind, name, minutes, kcal, distance_m, steps, source, demo, created_at) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, 'demo', 1, ?)",
        [userId, w.day, w.started_at, w.kind, w.minutes, w.kcal, w.distance_m, w.steps, now]);
    }
  });
  return {
    entries: rows.entries.length, weights: rows.weights.length, foods: created, water: rows.water.length, activity: rows.activity.length,
    workouts: rows.workouts.length, sleep: rows.sleep.length,
  };
}

/** Delete this user's demo rows, then demo foods no diary entry of anyone refers to any more. */
export async function removeDemo(db: Db, userId: number) {
  return db.tx(async (con) => {
    const del = async (table: string) => (await con.run(`DELETE FROM ${table} WHERE user_id = ? AND demo = 1`, [userId])).changes;
    const entries = await del('diary_entry'), weights = await del('weight'), water = await del('water');
    const activity = await del('activity_day'), workouts = await del('workout');
    await del('sleep_day');
    const doomed = (await con.all(`SELECT id FROM food WHERE ${DEMO_FOOD} AND id NOT IN (SELECT food_id FROM diary_entry WHERE food_id IS NOT NULL)`)).map((r) => r.id);
    for (const id of doomed) {
      for (const table of ['diary_entry', 'template_item', 'recipe_item']) await con.run(`UPDATE ${table} SET food_id = NULL WHERE food_id = ?`, [id]);
      await con.run('DELETE FROM food WHERE id = ?', [id]);
    }
    await del('badge_earned');
    return { entries, weights, foods: doomed.length, water, activity, workouts };
  });
}
