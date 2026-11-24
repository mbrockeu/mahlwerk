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

/** Apply the days of a `POST /health/sync` in ONE transaction. Idempotent: the same call twice changes nothing. Daily activity
 * values are written with source `health` and overwrite earlier health, Yazio and demo values, but not a `manual` row (unless
 * `overwriteManual`); weight and water only where there is none yet or the existing one came from here or is demo data; workouts
 * are recognised by `external_id`, a manual one is left alone. Body fat and lean mass live on the weight row and are stored only
 * where one exists. Each value has its own provenance flag: a value typed in by hand is never replaced. */
export async function healthSync(db: Db, userId: number, days: SyncDay[], overwriteManual: boolean, now: number) {
  const counts = Object.fromEntries(KINDS.map((k) => [k, { new: 0, updated: 0, unchanged: 0, skipped: 0 }])) as SyncCounts;
  const changed: { activity: string[]; workouts: number[] } = { activity: [], workouts: [] };
  await db.tx(async (con) => {
    for (const item of days) {
      const day = item.day;
      const given: Record<string, number> = {};
      for (const k of ['steps', 'active_kcal', 'distance_m'] as const) if (item[k] !== null && item[k] !== undefined) given[k] = item[k]!;
      if (Object.keys(given).length) {
        const row = await con.get('SELECT steps, active_kcal, distance_m, source FROM activity_day WHERE user_id = ? AND day = ?', [userId, day]);
        if (!row) {
          await con.run("INSERT INTO activity_day (user_id, day, steps, active_kcal, distance_m, source) VALUES (?, ?, ?, ?, ?, 'health')",
            [userId, day, given.steps ?? null, given.active_kcal ?? null, given.distance_m ?? null]);
          counts.activity.new++;
          changed.activity.push(day);
        } else if (row.source === 'manual' && !overwriteManual) counts.activity.skipped++;
        else {
          const merged = { ...row, ...given };
          if (row.source === 'health' && Object.keys(given).every((k) => merged[k] === row[k])) counts.activity.unchanged++;
          else {
            await con.run("UPDATE activity_day SET steps = ?, active_kcal = ?, distance_m = ?, source = 'health', import_id = NULL, demo = 0 WHERE user_id = ? AND day = ?",
              [merged.steps, merged.active_kcal, merged.distance_m, userId, day]);
            counts.activity.updated++;
            changed.activity.push(day);
          }
        }
      }
      for (const [table, column, key, kind] of [['weight', 'kg', 'weight_kg', 'weights'], ['water', 'ml', 'water_ml', 'water']] as const) {
        const value = item[key];
        if (value === null || value === undefined) continue;
        const row = await con.get(`SELECT ${column} AS v, health, demo FROM ${table} WHERE user_id = ? AND day = ?`, [userId, day]);
        if (!row) {
          await con.run(`INSERT INTO ${table} (user_id, day, ${column}, health) VALUES (?, ?, ?, 1)`, [userId, day, value]);
          counts[kind].new++;
        } else if (!(row.health || row.demo)) counts[kind].skipped++;
        else if (row.health && row.v === value) counts[kind].unchanged++;
        else {
          await con.run(`UPDATE ${table} SET ${column} = ?, health = 1, demo = 0 WHERE user_id = ? AND day = ?`, [value, userId, day]);
          counts[kind].updated++;
        }
      }
      for (const [column, flag, key, kind] of [['body_fat_pct', 'body_fat_health', 'body_fat_pct', 'body_fat'], ['lean_kg', 'lean_health', 'lean_kg', 'lean']] as const) {
        const value = item[key];
        if (value === null || value === undefined) continue;
        const row = await con.get(`SELECT ${column} AS v, ${flag} AS health FROM weight WHERE user_id = ? AND day = ?`, [userId, day]);
        if (!row) counts[kind].skipped++;
        else if (row.v === null) {
          await con.run(`UPDATE weight SET ${column} = ?, ${flag} = 1 WHERE user_id = ? AND day = ?`, [value, userId, day]);
          counts[kind].new++;
        } else if (!row.health) counts[kind].skipped++;
        else if (row.v === value) counts[kind].unchanged++;
        else {
          await con.run(`UPDATE weight SET ${column} = ? WHERE user_id = ? AND day = ?`, [value, userId, day]);
          counts[kind].updated++;
        }
      }
      const minutes = item.sleep_minutes;
      if (minutes !== null && minutes !== undefined) {
        const row = await con.get('SELECT minutes, source FROM sleep_day WHERE user_id = ? AND day = ?', [userId, day]);
        if (minutes < MIN_SLEEP_MINUTES) counts.sleep.skipped++; // a watch not worn is not a sleepless night
        else if (!row) {
          await con.run("INSERT INTO sleep_day (user_id, day, minutes, source) VALUES (?, ?, ?, 'health')", [userId, day, minutes]);
          counts.sleep.new++;
        } else if (row.source === 'health' && row.minutes === minutes) counts.sleep.unchanged++;
        else if (row.source === 'manual' && !overwriteManual) counts.sleep.skipped++;
        else {
          await con.run("UPDATE sleep_day SET minutes = ?, source = 'health', demo = 0 WHERE user_id = ? AND day = ?", [minutes, userId, day]);
          counts.sleep.updated++;
        }
      }
      for (const w of item.workouts ?? []) {
        const row = await con.get('SELECT * FROM workout WHERE user_id = ? AND external_id = ?', [userId, w.external_id]);
        const fields: Record<string, unknown> = {
          day, started_at: w.started_at ?? null, kind: w.kind, name: w.name || '', minutes: w.minutes, kcal: w.kcal ?? null, distance_m: w.distance_m ?? null,
        };
        if (!row) {
          const r = await con.run("INSERT INTO workout (user_id, day, started_at, kind, name, minutes, kcal, distance_m, source, external_id, created_at) "
            + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'health', ?, ?)",
          [userId, day, fields.started_at, fields.kind, fields.name, fields.minutes, fields.kcal, fields.distance_m, w.external_id, now] as any);
          counts.workouts.new++;
          changed.workouts.push(r.lastId);
        } else if (row.source === 'manual' && !overwriteManual) counts.workouts.skipped++;
        else if (row.source === 'health' && Object.entries(fields).every(([k, v]) => row[k] === v)) counts.workouts.unchanged++;
        else {
          await con.run("UPDATE workout SET day = ?, started_at = ?, kind = ?, name = ?, minutes = ?, kcal = ?, distance_m = ?, source = 'health', import_id = NULL, demo = 0 WHERE id = ?",
            [...(Object.values(fields) as any[]), row.id]);
          counts.workouts.updated++;
        }
      }
    }
  });
  return { counts, changed };
}
