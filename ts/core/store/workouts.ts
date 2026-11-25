// Sleep, manual activity values, workouts and the bulk Health sync (db.py: sleep_between, put_activity, workouts_for_badges,
// get/add/update/delete_workout, health_sync).
import type { Db, Row } from '../db.ts';

export const MIN_SLEEP_MINUTES = 60; // a shorter "night" in the Health data means the watch was not worn, not that nobody slept

/** Minutes asleep by day (the night that ended on that morning) in the range. */
export async function sleepBetween(db: Db, userId: number, first: string, last: string): Promise<Record<string, number>> {
  const rows = await db.all('SELECT day, minutes FROM sleep_day WHERE user_id = ? AND day BETWEEN ? AND ?', [userId, first, last]);
  return Object.fromEntries(rows.map((r) => [r.day, r.minutes]));
}

/** Set the given values of a day (null clears one), by hand: the row becomes `manual` and loses its import. A row that ends
 * up without any value is deleted. */
export async function putActivity(db: Db, userId: number, day: string, changes: Record<string, number | null>): Promise<void> {
  await db.tx(async (tx) => {
    const row = await tx.get('SELECT steps, active_kcal, distance_m FROM activity_day WHERE user_id = ? AND day = ?', [userId, day]);
    const merged = { ...(row ?? { steps: null, active_kcal: null, distance_m: null }), ...changes } as Record<string, number | null>;
    if (Object.values(merged).every((v) => v === null)) {
      await tx.run('DELETE FROM activity_day WHERE user_id = ? AND day = ?', [userId, day]);
      return;
    }
    await tx.run("INSERT INTO activity_day (user_id, day, steps, active_kcal, distance_m, source, import_id, demo) VALUES (?, ?, ?, ?, ?, 'manual', NULL, 0) "
      + "ON CONFLICT(user_id, day) DO UPDATE SET steps = excluded.steps, active_kcal = excluded.active_kcal, "
      + "distance_m = excluded.distance_m, source = 'manual', import_id = NULL, demo = 0",
    [userId, day, merged.steps, merged.active_kcal, merged.distance_m]);
  });
}

/** Every workout as (day, minutes, demo): what the training badges look at. */
export const workoutsForBadges = (db: Db, userId: number): Promise<{ day: string; minutes: number; demo: number }[]> =>
  db.all('SELECT day, minutes, demo FROM workout WHERE user_id = ?', [userId]) as any;

export const getWorkout = (db: Db, userId: number, workoutId: number): Promise<Row | undefined> =>
  db.get('SELECT * FROM workout WHERE id = ? AND user_id = ?', [workoutId, userId]);

/** Insert a workout typed in by the user (day, kind, name, minutes, kcal, distance_m, steps, started_at, note). */
export async function addWorkout(db: Db, userId: number, w: Record<string, any>, now: number): Promise<number> {
  return (await db.run("INSERT INTO workout (user_id, day, started_at, kind, name, minutes, kcal, distance_m, steps, note, source, created_at) "
    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)",
  [userId, w.day, w.started_at ?? null, w.kind, w.name || '', w.minutes, w.kcal ?? null, w.distance_m ?? null, w.steps ?? null, w.note ?? null, now])).lastId;
}

/** Change columns of one workout (the keys come from the validated patch); a change by hand makes it `manual` and takes it out
 * of its import batch (the external id stays, so a later sync or import does not add it again). */
export async function updateWorkout(db: Db, userId: number, workoutId: number, changes: Record<string, unknown>): Promise<boolean> {
  const keys = Object.keys(changes);
  if (!keys.length) return (await getWorkout(db, userId, workoutId)) !== undefined;
  return (await db.run(`UPDATE workout SET ${keys.map((k) => `${k} = ?`).join(', ')}, source = 'manual', import_id = NULL, demo = 0 WHERE id = ? AND user_id = ?`,
    [...(Object.values(changes) as any[]), workoutId, userId])).changes > 0;
}

export async function deleteWorkout(db: Db, userId: number, workoutId: number): Promise<boolean> {
  return (await db.run('DELETE FROM workout WHERE id = ? AND user_id = ?', [workoutId, userId])).changes > 0;
}

// health sync --------------------------------------------------------------------------------------------------------

export interface SyncWorkout { external_id: string; kind: string; name: string; started_at: number | null; minutes: number; kcal: number | null; distance_m: number | null }
export interface SyncDay {
  day: string; steps: number | null; active_kcal: number | null; distance_m: number | null; weight_kg: number | null; body_fat_pct: number | null;
  lean_kg: number | null; water_ml: number | null; sleep_minutes: number | null; workouts: SyncWorkout[];
}
const KINDS = ['activity', 'workouts', 'weights', 'water', 'body_fat', 'lean', 'sleep'] as const;
export type SyncCounts = Record<(typeof KINDS)[number], { new: number; updated: number; unchanged: number; skipped: number }>;

/** Rows of `table` for the given days (one query, the days as a JSON list: strings only, no number goes through JSON). */
const rowsOfDays = async (con: Db, table: string, columns: string, userId: number, days: string[]): Promise<Map<string, Row>> =>
  new Map((await con.all(`SELECT day, ${columns} FROM ${table} WHERE user_id = ? AND day IN (SELECT value FROM json_each(?))`,
    [userId, JSON.stringify(days)])).map((r) => [r.day as string, r]));

/** INSERT … VALUES (…), (…) … for many rows, in chunks below SQLite's limit of bound parameters; the values are bound like single
 * statements bind them (a JS number as REAL), so the stored values are the same. `tail` is the ON CONFLICT clause. */
async function insertMany(con: Db, head: string, rowSql: string, rows: unknown[][], tail: string): Promise<void> {
  if (!rows.length) return;
  const per = Math.max(1, Math.floor(900 / rows[0]!.length));
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    await con.run(`${head} VALUES ${chunk.map(() => rowSql).join(', ')} ${tail}`, chunk.flat() as any);
  }
}

/** Apply the days of a `POST /health/sync` in ONE transaction. Idempotent: the same call twice changes nothing. Daily activity
 * values are written with source `health` and overwrite earlier health, Yazio and demo values, but not a `manual` row (unless
 * `overwriteManual`); weight and water only where there is none yet or the existing one came from here or is demo data; workouts
 * are recognised by `external_id`, a manual one is left alone. Body fat and lean mass live on the weight row and are stored only
 * where one exists. Each value has its own provenance flag: a value typed in by hand is never replaced.
 * The rows of the synced days (and workouts) are read up front with one query per table; the days are then decided in memory in
 * the order of the call (a later item sees what an earlier one wrote, as with a write per item), and only the rows that change are
 * written, one statement per table (and chunk). */
export async function healthSync(db: Db, userId: number, days: SyncDay[], overwriteManual: boolean, now: number) {
  const counts = Object.fromEntries(KINDS.map((k) => [k, { new: 0, updated: 0, unchanged: 0, skipped: 0 }])) as SyncCounts;
  const changed: { activity: string[]; workouts: number[] } = { activity: [], workouts: [] };
  await db.tx(async (con) => {
    const dayList = [...new Set(days.map((d) => d.day))];
    const extIds = [...new Set(days.flatMap((d) => (d.workouts ?? []).map((w) => w.external_id)))];
    // what is stored now; the maps then hold the state as the writes below leave it
    const activityRows = await rowsOfDays(con, 'activity_day', 'steps, active_kcal, distance_m, source', userId, dayList);
    const weightRows = await rowsOfDays(con, 'weight', 'kg, health, demo, body_fat_pct, body_fat_health, lean_kg, lean_health', userId, dayList);
    const waterRows = await rowsOfDays(con, 'water', 'ml, health, demo', userId, dayList);
    const sleepRows = await rowsOfDays(con, 'sleep_day', 'minutes, source, demo', userId, dayList);
    const workoutRows = new Map<string, Row>(extIds.length ? (await con.all('SELECT * FROM workout WHERE user_id = ? AND external_id IN (SELECT value FROM json_each(?))',
      [userId, JSON.stringify(extIds)])).map((r) => [r.external_id as string, r]) : []);
    const dirty = { activity: new Set<string>(), weight: new Set<string>(), water: new Set<string>(), sleep: new Set<string>(), workout: new Set<string>() };
    const newWorkouts: string[] = []; // external ids in the order of their insert
    for (const item of days) {
      const day = item.day;
      const given: Record<string, number> = {};
      for (const k of ['steps', 'active_kcal', 'distance_m'] as const) if (item[k] !== null && item[k] !== undefined) given[k] = item[k]!;
      if (Object.keys(given).length) {
        const row = activityRows.get(day);
        if (!row) {
          activityRows.set(day, { day, steps: given.steps ?? null, active_kcal: given.active_kcal ?? null, distance_m: given.distance_m ?? null, source: 'health' });
          dirty.activity.add(day);
          counts.activity.new++;
          changed.activity.push(day);
        } else if (row.source === 'manual' && !overwriteManual) counts.activity.skipped++;
        else {
          const merged = { ...row, ...given };
          if (row.source === 'health' && Object.keys(given).every((k) => merged[k] === row[k])) counts.activity.unchanged++;
          else {
            activityRows.set(day, { ...merged, source: 'health' });
            dirty.activity.add(day);
            counts.activity.updated++;
            changed.activity.push(day);
          }
        }
      }
      for (const [rows, column, key, kind, table] of [[weightRows, 'kg', 'weight_kg', 'weights', 'weight'], [waterRows, 'ml', 'water_ml', 'water', 'water']] as const) {
        const value = item[key];
        if (value === null || value === undefined) continue;
        const row = rows.get(day);
        if (!row) {
          rows.set(day, table === 'weight'
            ? { day, kg: value, health: 1, demo: 0, body_fat_pct: null, body_fat_health: 0, lean_kg: null, lean_health: 0 }
            : { day, ml: value, health: 1, demo: 0 });
          dirty[table].add(day);
          counts[kind].new++;
        } else if (!(row.health || row.demo)) counts[kind].skipped++;
        else if (row.health && row[column] === value) counts[kind].unchanged++;
        else {
          rows.set(day, { ...row, [column]: value, health: 1, demo: 0 });
          dirty[table].add(day);
          counts[kind].updated++;
        }
      }
      for (const [column, flag, key, kind] of [['body_fat_pct', 'body_fat_health', 'body_fat_pct', 'body_fat'], ['lean_kg', 'lean_health', 'lean_kg', 'lean']] as const) {
        const value = item[key];
        if (value === null || value === undefined) continue;
        const row = weightRows.get(day);
        if (!row) counts[kind].skipped++;
        else if (row[column] === null) {
          weightRows.set(day, { ...row, [column]: value, [flag]: 1 });
          dirty.weight.add(day);
          counts[kind].new++;
        } else if (!row[flag]) counts[kind].skipped++;
        else if (row[column] === value) counts[kind].unchanged++;
        else {
          weightRows.set(day, { ...row, [column]: value });
          dirty.weight.add(day);
          counts[kind].updated++;
        }
      }
      const minutes = item.sleep_minutes;
      if (minutes !== null && minutes !== undefined) {
        const row = sleepRows.get(day);
        if (minutes < MIN_SLEEP_MINUTES) counts.sleep.skipped++; // a watch not worn is not a sleepless night
        else if (!row) {
          sleepRows.set(day, { day, minutes, source: 'health', demo: 0 });
          dirty.sleep.add(day);
          counts.sleep.new++;
        } else if (row.source === 'health' && row.minutes === minutes) counts.sleep.unchanged++;
        else if (row.source === 'manual' && !overwriteManual) counts.sleep.skipped++;
        else {
          sleepRows.set(day, { ...row, minutes, source: 'health', demo: 0 });
          dirty.sleep.add(day);
          counts.sleep.updated++;
        }
      }
      for (const w of item.workouts ?? []) {
        const row = workoutRows.get(w.external_id);
        const fields: Record<string, unknown> = {
          day, started_at: w.started_at ?? null, kind: w.kind, name: w.name || '', minutes: w.minutes, kcal: w.kcal ?? null, distance_m: w.distance_m ?? null,
        };
        if (!row) {
          workoutRows.set(w.external_id, { ...fields, external_id: w.external_id, source: 'health' });
          newWorkouts.push(w.external_id);
          dirty.workout.add(w.external_id);
          counts.workouts.new++;
        } else if (row.source === 'manual' && !overwriteManual) counts.workouts.skipped++;
        else if (row.source === 'health' && Object.entries(fields).every(([k, v]) => row[k] === v)) counts.workouts.unchanged++;
        else {
          workoutRows.set(w.external_id, { ...row, ...fields, source: 'health' });
          dirty.workout.add(w.external_id);
          counts.workouts.updated++;
        }
      }
    }
    // the writes: one upsert per table with the final state of each changed row (a new row is inserted, a known one updated)
    const pick = (rows: Map<string, Row>, keys: Iterable<string>, columns: string[]) => [...keys].map((k) => { const r = rows.get(k)!; return [userId, k, ...columns.map((c) => r[c])]; });
    await insertMany(con, 'INSERT INTO activity_day (user_id, day, steps, active_kcal, distance_m, source)', "(?, ?, ?, ?, ?, 'health')",
      pick(activityRows, dirty.activity, ['steps', 'active_kcal', 'distance_m']),
      "ON CONFLICT(user_id, day) DO UPDATE SET steps = excluded.steps, active_kcal = excluded.active_kcal, distance_m = excluded.distance_m, source = 'health', import_id = NULL, demo = 0");
    const weightCols = ['kg', 'health', 'demo', 'body_fat_pct', 'body_fat_health', 'lean_kg', 'lean_health'];
    await insertMany(con, `INSERT INTO weight (user_id, day, ${weightCols.join(', ')})`, `(${['?', '?', ...weightCols.map(() => '?')].join(', ')})`,
      pick(weightRows, dirty.weight, weightCols), `ON CONFLICT(user_id, day) DO UPDATE SET ${weightCols.map((c) => `${c} = excluded.${c}`).join(', ')}`);
    await insertMany(con, 'INSERT INTO water (user_id, day, ml, health, demo)', '(?, ?, ?, ?, ?)', pick(waterRows, dirty.water, ['ml', 'health', 'demo']),
      'ON CONFLICT(user_id, day) DO UPDATE SET ml = excluded.ml, health = excluded.health, demo = excluded.demo');
    await insertMany(con, 'INSERT INTO sleep_day (user_id, day, minutes, source, demo)', '(?, ?, ?, ?, ?)', pick(sleepRows, dirty.sleep, ['minutes', 'source', 'demo']),
      'ON CONFLICT(user_id, day) DO UPDATE SET minutes = excluded.minutes, source = excluded.source, demo = excluded.demo');
    const workoutCols = ['day', 'started_at', 'kind', 'name', 'minutes', 'kcal', 'distance_m'];
    // new ones first in the order of the call (their ids follow that order, as with one insert each), then the updates
    const order = [...newWorkouts, ...[...dirty.workout].filter((x) => !newWorkouts.includes(x))];
    await insertMany(con, `INSERT INTO workout (user_id, external_id, ${workoutCols.join(', ')}, source, created_at)`, `(?, ?, ${workoutCols.map(() => '?').join(', ')}, 'health', ?)`,
      order.map((x) => { const r = workoutRows.get(x)!; return [userId, x, ...workoutCols.map((c) => r[c]), now]; }),
      `ON CONFLICT(user_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET ${workoutCols.map((c) => `${c} = excluded.${c}`).join(', ')}, source = 'health', import_id = NULL, demo = 0`);
    if (newWorkouts.length) {
      const ids = new Map((await con.all('SELECT id, external_id FROM workout WHERE user_id = ? AND external_id IN (SELECT value FROM json_each(?))',
        [userId, JSON.stringify(newWorkouts)])).map((r) => [r.external_id as string, r.id as number]));
      changed.workouts.push(...newWorkouts.map((x) => ids.get(x)!));
    }
  });
  return { counts, changed };
}
