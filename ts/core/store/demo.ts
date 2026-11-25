// Demo data rows and the built-in demo account (db.py: demo_counts, add_demo, remove_demo, create_demo_user, erase_user_data …) and
// the admin overview (admin_counts, admin_users).
import type { Db } from '../db.ts';
import { toJson } from '../db.ts';
import { getGlobal, setGlobal } from './globals.ts';
import { NameTaken } from './users.ts';

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

export const RESERVED_USERNAME = '~demo';
export const DEMO_ACCOUNT_SETTING = 'demo_account.user_id';
export const DEMO_DELETED_SETTING = 'demo_account.deleted';

// every table with a `user_id` column
const USER_TABLES = ['diary_entry', 'goal', 'weight', 'template', 'user_setting', 'badge_earned', 'water', 'fast', 'import_batch',
  'access_token', 'webhook', 'activity_day', 'workout', 'auth_session', 'oidc_identity', 'secret', 'goal_history', 'sleep_day'];

const now = () => Math.floor(Date.now() / 1000); // time.time()

const unlinkFood = async (db: Db, foodId: number): Promise<void> => {
  for (const table of ['diary_entry', 'template_item', 'recipe_item']) await db.run(`UPDATE ${table} SET food_id = NULL WHERE food_id = ?`, [foodId]);
};

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
