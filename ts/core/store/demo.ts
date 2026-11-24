// Demo data and the built-in demo account (db.py: demo_counts, add_demo, remove_demo, create_demo_user, erase_user_data …) and the
// admin overview (admin_counts, admin_users).
import type { Db } from '../db.ts';
import { toJson } from '../db.ts';
import { getGlobal, setGlobal } from './globals.ts';
import { NameTaken } from './users.ts';

export const RESERVED_USERNAME = '~demo';
export const DEMO_ACCOUNT_SETTING = 'demo_account.user_id';
export const DEMO_DELETED_SETTING = 'demo_account.deleted';
const DEMO_FOOD = "json_extract(data, '$.demo') = 1";
const DEMO_ACCOUNT_FOOD = "json_extract(data, '$.demo_account') = 1";
const FOOD_MARKERS: Record<string, string> = { demo: DEMO_FOOD, demo_account: DEMO_ACCOUNT_FOOD }; // the only values `marker` may take (they go into SQL text)

// every table with a `user_id` column
const USER_TABLES = ['diary_entry', 'goal', 'weight', 'template', 'user_setting', 'badge_earned', 'water', 'fast', 'import_batch',
  'access_token', 'webhook', 'activity_day', 'workout', 'auth_session', 'oidc_identity', 'secret', 'goal_history', 'sleep_day'];

const now = () => Math.floor(Date.now() / 1000); // time.time()

export async function demoCounts(db: Db, userId: number) {
  const n = async (table: string) => (await db.get(`SELECT count(*) AS n FROM ${table} WHERE user_id = ? AND demo = 1`, [userId]))!.n as number;
  return { entries: await n('diary_entry'), weights: await n('weight'), water: await n('water'), activity: await n('activity_day'), workouts: await n('workout') };
}

/** Days in the range that have an activity row, and days that have a workout. */
export async function activityDays(db: Db, userId: number, first: string, last: string): Promise<[Set<string>, Set<string>]> {
  const a = await db.all('SELECT day FROM activity_day WHERE user_id = ? AND day BETWEEN ? AND ?', [userId, first, last]);
  const w = await db.all('SELECT DISTINCT day FROM workout WHERE user_id = ? AND day BETWEEN ? AND ?', [userId, first, last]);
  return [new Set(a.map((r) => r.day)), new Set(w.map((r) => r.day))];
}

/** Days in the range with real entries and days with demo entries. */
export async function diaryDays(db: Db, userId: number, first: string, last: string): Promise<[Set<string>, Set<string>]> {
  const rows = await db.all('SELECT DISTINCT day, demo FROM diary_entry WHERE user_id = ? AND day BETWEEN ? AND ?', [userId, first, last]);
  return [new Set(rows.filter((r) => !r.demo).map((r) => r.day)), new Set(rows.filter((r) => r.demo).map((r) => r.day))];
}

const daysOf = async (db: Db, table: string, userId: number, first: string, last: string): Promise<Set<string>> =>
  new Set((await db.all(`SELECT day FROM ${table} WHERE user_id = ? AND day BETWEEN ? AND ?`, [userId, first, last])).map((r) => r.day));
export const weightDays = (db: Db, userId: number, first: string, last: string) => daysOf(db, 'weight', userId, first, last);
export const waterDays = (db: Db, userId: number, first: string, last: string) => daysOf(db, 'water', userId, first, last);

/** Minutes asleep by day in the range. */
export async function sleepBetween(db: Db, userId: number, first: string, last: string): Promise<Record<string, number>> {
  const rows = await db.all('SELECT day, minutes FROM sleep_day WHERE user_id = ? AND day BETWEEN ? AND ?', [userId, first, last]);
  return Object.fromEntries(rows.map((r) => [r.day, r.minutes]));
}

/** Set the current goal and record it in the history from `validFrom` on (db.py: set_goal; the insights package has the general one). */
export async function setDemoGoal(db: Db, userId: number, goal: { kcal: number; protein: number; carbs: number; fat: number }, validFrom: string): Promise<void> {
  const v = { user_id: userId, water_ml: 2000, steps: 8000, ...goal, valid_from: validFrom, changed_at: now() };
  await db.tx(async (tx) => {
    await tx.run('INSERT INTO goal (user_id, kcal, protein, carbs, fat, water_ml, steps) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(user_id) DO UPDATE SET kcal = excluded.kcal, protein = excluded.protein, carbs = excluded.carbs, fat = excluded.fat, ' +
      'water_ml = excluded.water_ml, steps = excluded.steps, import_id = NULL', [v.user_id, v.kcal, v.protein, v.carbs, v.fat, v.water_ml, v.steps]);
    await tx.run('INSERT INTO goal_history (user_id, valid_from, kcal, protein, carbs, fat, water_ml, steps, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(user_id, valid_from) DO UPDATE SET kcal = excluded.kcal, protein = excluded.protein, carbs = excluded.carbs, fat = excluded.fat, ' +
      'water_ml = excluded.water_ml, steps = excluded.steps, changed_at = excluded.changed_at',
    [v.user_id, v.valid_from, v.kcal, v.protein, v.carbs, v.fat, v.water_ml, v.steps, v.changed_at]);
  });
}

export interface DemoFood { name: string; unit: string; per_100: Record<string, number | null>; extra?: Record<string, number>; [k: string]: unknown }

/** Insert demo entries and weights in one transaction. `foods` maps a name to the food data; a demo food of that name is reused,
 * otherwise created. Returns the number of new rows. `marker` says which kind of demo food is meant. */
export async function addDemo(db: Db, userId: number, foods: Record<string, DemoFood>, entries: { day: string; meal: string; food: string; amount: number }[],
  weights: { day: string; kg: number }[], water: { day: string; ml: number }[], activity: { day: string; steps: number; active_kcal: number; distance_m: number }[],
  workouts: Record<string, any>[], sleep: { day: string; minutes: number }[], marker = 'demo') {
  const where = FOOD_MARKERS[marker]!;
  const at = now();
  return db.tx(async (tx) => {
    const ids = new Map<string, number>();
    let created = 0;
    const known = new Map<string, number>();
    for (const r of await tx.all(`SELECT id, data FROM food WHERE ${where}`)) known.set(JSON.parse(r.data).name, r.id);
    for (const name of new Set(entries.map((e) => e.food))) {
      const have = known.get(name);
      if (have !== undefined) { ids.set(name, have); continue; }
      const r = await tx.run("INSERT INTO food (code, source, found, data, fetched_at) VALUES (NULL, 'own', 1, ?, ?)", [toJson({ ...foods[name], [marker]: true }), at]);
      ids.set(name, r.lastId);
      created++;
    }
    for (const e of entries) {
      const data = foods[e.food]!;
      await tx.run('INSERT INTO diary_entry (user_id, day, meal, food_id, amount, unit, name, brand, per_100, extra, created_at, demo) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1)',
        [userId, e.day, e.meal, ids.get(e.food)!, e.amount, data.unit, data.name, toJson(data.per_100), toJson(data.extra ?? {}), at]);
    }
    for (const w of weights) await tx.run('INSERT OR IGNORE INTO weight (user_id, day, kg, demo) VALUES (?, ?, ?, 1)', [userId, w.day, w.kg]);
    for (const w of water) await tx.run('INSERT OR IGNORE INTO water (user_id, day, ml, demo) VALUES (?, ?, ?, 1)', [userId, w.day, w.ml]);
    for (const a of activity) {
      await tx.run("INSERT OR IGNORE INTO activity_day (user_id, day, steps, active_kcal, distance_m, source, demo) VALUES (?, ?, ?, ?, ?, 'demo', 1)", [userId, a.day, a.steps, a.active_kcal, a.distance_m]);
    }
    for (const s of sleep) await tx.run("INSERT OR IGNORE INTO sleep_day (user_id, day, minutes, source, demo) VALUES (?, ?, ?, 'demo', 1)", [userId, s.day, s.minutes]);
    for (const w of workouts) {
      await tx.run("INSERT INTO workout (user_id, day, started_at, kind, name, minutes, kcal, distance_m, steps, source, demo, created_at) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, 'demo', 1, ?)",
        [userId, w.day, w.started_at, w.kind, w.minutes, w.kcal, w.distance_m, w.steps, at]);
    }
    return { entries: entries.length, weights: weights.length, foods: created, water: water.length, activity: activity.length, workouts: workouts.length, sleep: sleep.length };
  });
}

const unlinkFood = async (db: Db, foodId: number): Promise<void> => {
  for (const table of ['diary_entry', 'template_item', 'recipe_item']) await db.run(`UPDATE ${table} SET food_id = NULL WHERE food_id = ?`, [foodId]);
};

/** Delete this user's demo rows, then demo foods no diary entry of anyone refers to any more. */
export async function removeDemo(db: Db, userId: number) {
  return db.tx(async (tx) => {
    const del = async (table: string) => (await tx.run(`DELETE FROM ${table} WHERE user_id = ? AND demo = 1`, [userId])).changes;
    const entries = await del('diary_entry');
    const weights = await del('weight');
    const water = await del('water');
    const activity = await del('activity_day');
    const workouts = await del('workout');
    await del('sleep_day');
    const doomed = (await tx.all(`SELECT id FROM food WHERE ${DEMO_FOOD} AND id NOT IN (SELECT food_id FROM diary_entry WHERE food_id IS NOT NULL)`)).map((r) => r.id as number);
    for (const id of doomed) {
      await unlinkFood(tx, id);
      await tx.run('DELETE FROM food WHERE id = ?', [id]);
    }
    await del('badge_earned');
    return { entries, weights, foods: doomed.length, water, activity, workouts };
  });
}

// ---- the built-in demo account -------------------------------------------------------------------------------------------

/** The id of the demo account (the setting points at the user row with the reserved name), or null. Also while it is deleted. */
export async function demoAccountId(db: Db): Promise<number | null> {
  const value = await getGlobal(db, DEMO_ACCOUNT_SETTING);
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  const row = await db.get('SELECT id FROM user WHERE id = ? AND username = ?', [value, RESERVED_USERNAME]);
  return row ? row.id : null;
}

/** The id of the demo account when it exists and is not deleted, else null. */
export async function demoAccountReady(db: Db): Promise<number | null> {
  const id = await demoAccountId(db);
  return id === null || (await getGlobal(db, DEMO_DELETED_SETTING, false)) ? null : id;
}

/** The demo account's user id and whether it was made (or made again after a delete) now. Refuses (NameTaken) when a row of the
 * reserved name exists that the marker does not point to. The check, the insert and the marker are one write. */
export async function createDemoUser(db: Db): Promise<[number, boolean]> {
  let revived = false;
  const userId = await db.tx(async (tx) => {
    const row = await tx.get('SELECT id FROM user WHERE username = ?', [RESERVED_USERNAME]);
    const marker = await tx.get('SELECT value FROM setting WHERE key = ?', [DEMO_ACCOUNT_SETTING]);
    const deleted = await tx.get('SELECT value FROM setting WHERE key = ?', [DEMO_DELETED_SETTING]);
    if (row !== undefined) {
      if (marker === undefined || JSON.parse(marker.value) !== row.id) throw new NameTaken(RESERVED_USERNAME);
      if (deleted === undefined || !JSON.parse(deleted.value)) return -row.id; // not made now (negative: the flag of "unchanged")
      revived = true;
      return row.id as number;
    }
    const r = await tx.run("INSERT INTO user (username, display_name, created_at) VALUES (?, 'Demo', ?)", [RESERVED_USERNAME, now()]);
    await tx.run('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [DEMO_ACCOUNT_SETTING, toJson(r.lastId)]);
    return r.lastId;
  });
  if (userId < 0) return [-userId, false];
  if (revived) {
    await eraseUserData(db, userId);
    await setGlobal(db, DEMO_DELETED_SETTING, false);
  }
  return [userId, true];
}

/** A row of the reserved name exists that is not the demo account (only a hand-made database): it is never taken over. */
export async function demoNameTaken(db: Db): Promise<boolean> {
  const row = await db.get('SELECT id FROM user WHERE username = ?', [RESERVED_USERNAME]);
  return row !== undefined && row.id !== (await demoAccountId(db));
}

/** Everything of one user: diary, weights, water, goals, settings, templates ... Only for the demo account. ALL sample foods of the
 * demo account go too; shared recipes, products and groups of the household are never touched. With `deactivate` the account is
 * marked deleted FIRST so that no new demo request starts. */
export async function eraseUserData(db: Db, userId: number, deactivate = false): Promise<void> {
  if (deactivate) await setGlobal(db, DEMO_DELETED_SETTING, true);
  await db.tx(async (tx) => {
    await tx.run('DELETE FROM template_item WHERE template_id IN (SELECT id FROM template WHERE user_id = ?)', [userId]);
    await tx.run('DELETE FROM webhook_delivery WHERE webhook_id IN (SELECT id FROM webhook WHERE user_id = ?)', [userId]);
    for (const table of USER_TABLES) await tx.run(`DELETE FROM ${table} WHERE user_id = ?`, [userId]);
    for (const table of ['recipe', 'recipe_group']) await tx.run(`UPDATE ${table} SET created_by = NULL WHERE created_by = ?`, [userId]);
    for (const row of await tx.all(`SELECT id FROM food WHERE ${DEMO_ACCOUNT_FOOD}`)) {
      await unlinkFood(tx, row.id);
      await tx.run('DELETE FROM food WHERE id = ?', [row.id]);
    }
  });
}

/** What the demo account holds now: diary entries and the first and last day with one. */
export async function demoAccountSummary(db: Db, userId: number) {
  const row = (await db.get('SELECT count(*) AS n, min(day) AS first, max(day) AS last FROM diary_entry WHERE user_id = ?', [userId]))!;
  return { entries: row.n as number, first_day: row.first as string | null, last_day: row.last as string | null };
}

// ---- the admin overview --------------------------------------------------------------------------------------------------

export async function adminCounts(db: Db) {
  const one = async (sql: string, p: any[] = []) => (await db.get(sql, p))!.n as number;
  return {
    // the demo account is no user of this server and its invented entries and foods are no data of it: left out
    users: await one('SELECT count(*) AS n FROM user WHERE username <> ?', [RESERVED_USERNAME]),
    entries: await one('SELECT count(*) AS n FROM diary_entry WHERE user_id NOT IN (SELECT id FROM user WHERE username = ?)', [RESERVED_USERNAME]),
    foods: await one(`SELECT count(*) AS n FROM food WHERE found = 1 AND NOT COALESCE(${DEMO_ACCOUNT_FOOD}, 0)`),
    webhooks: await one('SELECT count(*) AS n FROM webhook'),
    import_batches: await one('SELECT count(*) AS n FROM import_batch'),
  };
}

/** One row per user with counts only: never diary content, weights or goals. */
export async function adminUsers(db: Db): Promise<Record<string, any>[]> {
  return db.all(
    'SELECT u.username, u.display_name, u.created_at, u.disabled, u.local_admin AS admin, (u.household OR u.local_admin) AS household, ' +
    '(u.password_hash IS NOT NULL) AS has_password, ' +
    "(u.username = '~demo') AS demo, " +
    "(SELECT json_extract(value, '$') FROM user_setting s WHERE s.user_id = u.id AND s.key = 'display_name') AS own_name, " +
    'EXISTS (SELECT 1 FROM oidc_identity i WHERE i.user_id = u.id) AS sso, ' +
    '(SELECT count(*) FROM diary_entry e WHERE e.user_id = u.id) AS entries, ' +
    '(SELECT min(day) FROM diary_entry e WHERE e.user_id = u.id) AS first_day, ' +
    '(SELECT max(day) FROM diary_entry e WHERE e.user_id = u.id) AS last_day, ' +
    '(SELECT count(*) FROM access_token t WHERE t.user_id = u.id AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?)) AS tokens, ' +
    '(SELECT count(*) FROM webhook w WHERE w.user_id = u.id) AS webhooks ' +
    'FROM user u ORDER BY u.username', [now()]);
}
