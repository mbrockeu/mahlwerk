// Import batches and the Yazio import (db.py: list_imports, import_yazio, _import_foods, remove_import).
import { toJson, type Db, type Row } from '../db.ts';
import { SINCE_START } from '../goals.ts';
import { roundHalfEven } from '../num.ts';

const COUNT_KEYS = ['days', 'entries', 'product_entries', 'recipe_entries', 'quick_entries', 'foods', 'weights', 'water', 'activity_days', 'workouts'] as const;

/** An import batch as the API shows it (ImportCounts: every count present, 0 or false where the run stored none). */
function batchView(row: Row) {
  const stored = JSON.parse(row.counts || '{}') as Record<string, unknown>;
  const counts: Record<string, unknown> = {};
  for (const key of COUNT_KEYS) counts[key] = stored[key] ?? 0;
  counts.goal_set = Boolean(stored.goal_set);
  return { id: row.id as number, kind: row.kind as string, created_at: row.created_at as number, counts };
}

/** The batches of one user, newest first. */
export async function listImports(db: Db, userId: number) {
  const rows = await db.all('SELECT b.*, u.username FROM import_batch b JOIN user u ON u.id = b.user_id WHERE b.user_id = ? ORDER BY b.id DESC', [userId]);
  return rows.map(batchView);
}

export interface PlanFood { code: string | null; data: Record<string, unknown> }
export interface PlanEntry {
  kind: 'product' | 'recipe' | 'quick'; external_id: string; day: string; meal: string; food_key: string | null; amount: number; unit: string;
  name: string; brand: string | null; per_100: Record<string, number | null>; extra: Record<string, number>;
}
export interface PlanWorkout {
  external_id: string; day: string; started_at: number | null; kind: string; name: string; minutes: number; kcal: number | null;
  distance_m: number | null; steps: number | null; note: string | null;
}
export interface PlanGoal { kcal: number; protein: number; carbs: number; fat: number; water_ml: number; steps: number | null }
export interface Plan {
  /** Refresh mode (see yazio.ts buildPlan): the period, and the ids Yazio listed for it (also those the importer skipped). */
  refresh?: { first_day: string; last_day: string } | null; seen_entries?: Set<string>; seen_workouts?: Set<string>;
  foods: Map<string, PlanFood>; entries: PlanEntry[]; weights: { day: string; kg: number }[]; water: { day: string; ml: number }[];
  all_products: boolean; goal: PlanGoal | null; activity: { day: string; steps: number | null; active_kcal: number | null; distance_m: number | null }[];
  workouts: PlanWorkout[];
}

/** Only used to roll a dry run back: thrown inside the transaction, caught right outside. */
class DryRun extends Error {
  result: Record<string, any>;
  constructor(result: Record<string, any>) { super('dry run'); this.result = result; }
}

/** Write a prepared Yazio import in ONE transaction; any error leaves the database as it was. Entries and workouts whose external id
 * the user already has are left out. A food is taken from an earlier import (same key) or from an existing food with the same barcode,
 * and created otherwise; an existing food is never changed. Weight, water and goal are only set where the user has none. With
 * `dryRun` everything is done and rolled back, so the counts are exact. */
export async function importYazio(db: Db, userId: number, plan: Plan, dryRun = false): Promise<Record<string, any>> {
  const now = Math.floor(Date.now() / 1000);
  const work = (tx: Db) => writePlan(tx, userId, plan, now);
  if (!dryRun) return finish(await db.tx(work), plan);
  try {
    await db.tx(async (tx) => { throw new DryRun(await work(tx)); });
  } catch (e) {
    if (e instanceof DryRun) return finish({ ...e.result, batch_id: null }, plan);
    throw e;
  }
  throw new Error('unreachable');
}

const finish = (r: Record<string, any>, plan: Plan) => ({ ...r, activity_kept: plan.activity.length - r.activity_days - r.activity_updated });

/** Numbers rounded to 6 places (ints and floats alike), keys sorted: what is compared to see whether Yazio changed a value (yazio: db.py `_norm`). */
function norm(value: unknown): unknown {
  if (typeof value === 'number') return roundHalfEven(value, 6);
  if (Array.isArray(value)) return value.map(norm);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, norm((value as Record<string, unknown>)[k])]));
  return value;
}
const canon = (value: unknown): string => JSON.stringify(norm(value));
const sameNumber = (a: unknown, b: unknown): boolean => (a === null && b === null) || (a !== null && b !== null && roundHalfEven(Number(a), 3) === roundHalfEven(Number(b), 3));
const sameKg = (a: unknown, b: unknown): boolean => roundHalfEven(Number(a), 2) === roundHalfEven(Number(b), 2);
const entryDiffers = (row: Row, e: PlanEntry): boolean => row.day !== e.day || row.meal !== e.meal || row.unit !== e.unit || row.name !== e.name || row.brand !== e.brand
  || canon(row.amount) !== canon(e.amount) || canon(JSON.parse(row.per_100)) !== canon(e.per_100) || canon(JSON.parse(row.extra || '{}')) !== canon(e.extra);
const workoutDiffers = (row: Row, w: PlanWorkout): boolean => row.day !== w.day || row.started_at !== w.started_at || row.kind !== w.kind || row.name !== w.name || row.note !== w.note
  || !(['minutes', 'kcal', 'distance_m', 'steps'] as const).every((k) => sameNumber(row[k], w[k]));
const chunks = <T>(list: T[], size = 500): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

async function writePlan(con: Db, userId: number, plan: Plan, now: number) {
  const refresh = plan.refresh ?? null;
  const [firstDay, lastDay] = refresh ? [refresh.first_day, refresh.last_day] : [null, null];
  const yazioBatch = "(SELECT id FROM import_batch WHERE user_id = ? AND kind = 'yazio')";
  const taken = new Set((await con.all('SELECT external_id FROM diary_entry WHERE user_id = ? AND external_id IS NOT NULL', [userId])).map((r) => r.external_id as string));
  // refresh: the Yazio rows of the period, by external id (rows outside it, manual, Health and changed ones are not in here)
  const scope = new Map<string, Row>();
  if (refresh) {
    for (const r of await con.all('SELECT id, external_id, day, meal, amount, unit, name, brand, per_100, extra FROM diary_entry '
      + `WHERE user_id = ? AND external_id IS NOT NULL AND day BETWEEN ? AND ? AND import_id IN ${yazioBatch}`, [userId, firstDay, lastDay, userId])) scope.set(r.external_id as string, r);
  }
  const entries: PlanEntry[] = [];
  const updates: [number, PlanEntry][] = [];
  const handled = new Set<string>();
  let already = 0;
  for (const entry of plan.entries) {
    const row = scope.get(entry.external_id);
    if (row && !handled.has(entry.external_id)) {
      handled.add(entry.external_id);
      if (entryDiffers(row, entry)) updates.push([row.id as number, entry]); else already++;
      continue;
    }
    if (taken.has(entry.external_id)) { already++; continue; }
    taken.add(entry.external_id);
    entries.push(entry);
  }
  const gone = refresh ? [...scope].filter(([ext]) => !plan.seen_entries!.has(ext)).map(([, r]) => r.id as number) : [];
  for (const chunk of chunks(gone)) await con.run(`DELETE FROM diary_entry WHERE id IN (${chunk.map(() => '?').join(', ')})`, chunk);
  let batchId: number | null = (await con.run("INSERT INTO import_batch (user_id, kind, created_at) VALUES (?, 'yazio', ?)", [userId, now])).lastId;
  const needed = [...new Set([...[...entries, ...updates.map((u) => u[1])].flatMap((e) => (e.food_key ? [e.food_key] : [])), ...(plan.all_products ? [...plan.foods.keys()] : [])])];
  const { ids, created, reused } = await importFoods(con, plan.foods, needed, batchId, now);
  for (const e of entries) {
    await con.run('INSERT INTO diary_entry (user_id, day, meal, food_id, amount, unit, name, brand, per_100, extra, created_at, external_id, import_id) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, e.day, e.meal, e.food_key ? ids.get(e.food_key) ?? null : null, e.amount, e.unit, e.name, e.brand, toJson(e.per_100), toJson(e.extra), now, e.external_id, batchId]);
  }
  for (const [rowId, e] of updates) {
    await con.run('UPDATE diary_entry SET day = ?, meal = ?, food_id = ?, amount = ?, unit = ?, name = ?, brand = ?, per_100 = ?, extra = ? WHERE id = ?',
      [e.day, e.meal, e.food_key ? ids.get(e.food_key) ?? null : null, e.amount, e.unit, e.name, e.brand, toJson(e.per_100), toJson(e.extra), rowId]);
  }
  let weights = 0, water = 0, goal = 0, activity = 0, weightsUpdated = 0, waterUpdated = 0, activityUpdated = 0;
  for (const [table, list, field] of [['weight', plan.weights, 'kg'], ['water', plan.water, 'ml']] as const) {
    const have = new Map<string, number>();
    if (refresh) {
      for (const r of await con.all(`SELECT day, ${field} FROM ${table} WHERE user_id = ? AND day BETWEEN ? AND ? AND import_id IN ${yazioBatch}`, [userId, firstDay, lastDay, userId])) have.set(r.day as string, r[field] as number);
    }
    let inserted = 0, updated = 0;
    for (const w of list as { day: string; kg?: number; ml?: number }[]) {
      const value = w[field]!;
      if (have.has(w.day)) {
        if (!sameKg(have.get(w.day), value)) { await con.run(`UPDATE ${table} SET ${field} = ? WHERE user_id = ? AND day = ?`, [value, userId, w.day]); updated++; }
        continue;
      }
      inserted += (await con.run(`INSERT OR IGNORE INTO ${table} (user_id, day, ${field}, demo, import_id) VALUES (?, ?, ?, 0, ?)`, [userId, w.day, value, batchId])).changes;
    }
    if (table === 'weight') { weights = inserted; weightsUpdated = updated; } else { water = inserted; waterUpdated = updated; }
  }
  if (plan.goal) {
    const g = plan.goal;
    goal = (await con.run('INSERT OR IGNORE INTO goal (user_id, kcal, protein, carbs, fat, water_ml, steps, import_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, g.kcal, g.protein, g.carbs, g.fat, g.water_ml, g.steps, batchId])).changes;
    if (goal) { // the user had no goal: the imported one counts for every day, the imported past included
      await con.run('INSERT INTO goal_history (user_id, valid_from, kcal, protein, carbs, fat, water_ml, steps, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) '
        + 'ON CONFLICT(user_id, valid_from) DO UPDATE SET kcal = excluded.kcal, protein = excluded.protein, carbs = excluded.carbs, fat = excluded.fat, '
        + 'water_ml = excluded.water_ml, steps = excluded.steps, changed_at = excluded.changed_at',
      [userId, SINCE_START, g.kcal, g.protein, g.carbs, g.fat, g.water_ml, g.steps, now]);
    }
  }
  const haveActivity = new Map<string, Row>();
  if (refresh) {
    for (const r of await con.all('SELECT day, steps, active_kcal, distance_m FROM activity_day WHERE user_id = ? AND day BETWEEN ? AND ? '
      + `AND source = 'yazio' AND import_id IN ${yazioBatch}`, [userId, firstDay, lastDay, userId])) haveActivity.set(r.day as string, r);
  }
  for (const a of plan.activity) {
    const row = haveActivity.get(a.day);
    if (row) {
      if (!(['steps', 'active_kcal', 'distance_m'] as const).every((k) => sameNumber(row[k], a[k]))) {
        await con.run('UPDATE activity_day SET steps = ?, active_kcal = ?, distance_m = ? WHERE user_id = ? AND day = ?', [a.steps, a.active_kcal, a.distance_m, userId, a.day]);
        activityUpdated++;
      }
      continue;
    }
    activity += (await con.run("INSERT OR IGNORE INTO activity_day (user_id, day, steps, active_kcal, distance_m, source, import_id) VALUES (?, ?, ?, ?, ?, 'yazio', ?)",
      [userId, a.day, a.steps, a.active_kcal, a.distance_m, batchId])).changes;
  }
  const known = new Set((await con.all('SELECT external_id FROM workout WHERE user_id = ? AND external_id IS NOT NULL', [userId])).map((r) => r.external_id as string));
  const workoutScope = new Map<string, Row>();
  if (refresh) {
    for (const r of await con.all('SELECT id, external_id, day, started_at, kind, name, minutes, kcal, distance_m, steps, note FROM workout '
      + `WHERE user_id = ? AND external_id IS NOT NULL AND source = 'yazio' AND day BETWEEN ? AND ? AND import_id IN ${yazioBatch}`, [userId, firstDay, lastDay, userId])) workoutScope.set(r.external_id as string, r);
  }
  const workouts: PlanWorkout[] = [];
  const workoutUpdates: [number, PlanWorkout][] = [];
  const workoutsHandled = new Set<string>();
  let workoutsAlready = 0;
  for (const w of plan.workouts) {
    const row = workoutScope.get(w.external_id);
    if (row && !workoutsHandled.has(w.external_id)) {
      workoutsHandled.add(w.external_id);
      if (workoutDiffers(row, w)) workoutUpdates.push([row.id as number, w]); else workoutsAlready++;
      continue;
    }
    if (known.has(w.external_id)) { workoutsAlready++; continue; }
    known.add(w.external_id);
    workouts.push(w);
  }
  const workoutsGone = refresh ? [...workoutScope].filter(([ext]) => !plan.seen_workouts!.has(ext)).map(([, r]) => r.id as number) : [];
  for (const chunk of chunks(workoutsGone)) await con.run(`DELETE FROM workout WHERE id IN (${chunk.map(() => '?').join(', ')})`, chunk);
  for (const [rowId, w] of workoutUpdates) {
    await con.run('UPDATE workout SET day = ?, started_at = ?, kind = ?, name = ?, minutes = ?, kcal = ?, distance_m = ?, steps = ?, note = ? WHERE id = ?',
      [w.day, w.started_at, w.kind, w.name, w.minutes, w.kcal, w.distance_m, w.steps, w.note, rowId]);
  }
  for (const w of workouts) {
    await con.run("INSERT INTO workout (user_id, day, started_at, kind, name, minutes, kcal, distance_m, steps, note, source, external_id, import_id, created_at) "
      + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'yazio', ?, ?, ?)",
    [userId, w.day, w.started_at, w.kind, w.name, w.minutes, w.kcal, w.distance_m, w.steps, w.note, w.external_id, batchId, now]);
  }
  const count = (kind: string) => entries.filter((e) => e.kind === kind).length;
  const counts = {
    days: new Set(entries.map((e) => e.day)).size, entries: entries.length, product_entries: count('product'), recipe_entries: count('recipe'),
    quick_entries: count('quick'), foods: created, weights, water, goal_set: Boolean(goal), activity_days: activity, workouts: workouts.length,
  };
  if (!(entries.length || created || weights || water || goal || activity || workouts.length)) {
    await con.run('DELETE FROM import_batch WHERE id = ?', [batchId]); // nothing to take back (updates and removals have no batch)
    batchId = null;
  } else await con.run('UPDATE import_batch SET counts = ? WHERE id = ?', [toJson(counts), batchId]);
  return {
    ...counts, foods_reused: reused, already_imported: already, batch_id: batchId, workouts_already: workoutsAlready, entries_updated: updates.length,
    entries_removed: gone.length, workouts_updated: workoutUpdates.length, workouts_removed: workoutsGone.length, weights_updated: weightsUpdated,
    water_updated: waterUpdated, activity_updated: activityUpdated,
  };
}

/** Food ids for the keys in `needed`. */
async function importFoods(con: Db, specs: Map<string, PlanFood>, needed: string[], batchId: number, now: number) {
  const known = new Map((await con.all('SELECT id, external_id FROM food WHERE external_id IS NOT NULL')).map((r) => [r.external_id as string, r.id as number]));
  const codes = needed.filter((k) => !known.has(k) && specs.get(k)!.code).map((k) => specs.get(k)!.code!);
  const byCode = new Map<string, [number, boolean]>();
  for (let start = 0; start < codes.length; start += 500) {
    const chunk = codes.slice(start, start + 500);
    for (const r of await con.all(`SELECT id, code, found FROM food WHERE code IN (${chunk.map(() => '?').join(', ')})`, chunk)) byCode.set(r.code, [r.id, Boolean(r.found)]);
  }
  const ids = new Map<string, number>();
  let created = 0, reused = 0;
  for (const key of needed) {
    const existing = known.get(key);
    if (existing !== undefined) { ids.set(key, existing); reused++; continue; }
    const code = specs.get(key)!.code;
    const hit = code ? byCode.get(code) : undefined;
    if (hit && hit[1]) { ids.set(key, hit[0]); reused++; continue; } // an existing food stays as it is
    const data = toJson(specs.get(key)!.data);
    if (hit) { // the barcode is only a remembered miss: the row becomes this food
      await con.run("UPDATE food SET source = 'yazio', found = 1, data = ?, fetched_at = ?, external_id = ?, import_id = ?, created_by = ? WHERE id = ?", [data, now, key, batchId, null, hit[0]]);
      ids.set(key, hit[0]);
    } else {
      ids.set(key, (await con.run("INSERT INTO food (code, source, found, data, fetched_at, external_id, import_id, created_by) VALUES (?, 'yazio', 1, ?, ?, ?, ?, ?)",
        [code, data, now, key, batchId, null])).lastId);
    }
    if (code) byCode.set(code, [ids.get(key)!, true]);
    created++;
  }
  return { ids, created, reused };
}

/** Take back one batch: its entries, weights, water, activity days, workouts and goal that are still untouched, and the foods it created
 * that nothing refers to any more. Null when the batch does not exist or belongs to someone else. */
export async function removeImport(db: Db, batchId: number, userId: number) {
  return db.tx(async (con) => {
    const row = await con.get('SELECT * FROM import_batch WHERE id = ?', [batchId]);
    if (!row || row.user_id !== userId) return null;
    const entries = (await con.run('DELETE FROM diary_entry WHERE import_id = ?', [batchId])).changes;
    const weights = (await con.run('DELETE FROM weight WHERE import_id = ?', [batchId])).changes;
    const water = (await con.run('DELETE FROM water WHERE import_id = ?', [batchId])).changes;
    const goal = (await con.run('DELETE FROM goal WHERE import_id = ?', [batchId])).changes;
    if (goal) await con.run('DELETE FROM goal_history WHERE user_id = ?', [row.user_id]); // untouched since the import: its history is only the imported row
    const activity = (await con.run('DELETE FROM activity_day WHERE import_id = ?', [batchId])).changes;
    const workouts = (await con.run('DELETE FROM workout WHERE import_id = ?', [batchId])).changes;
    const doomed = (await con.all('SELECT id FROM food WHERE import_id = ? AND id NOT IN (SELECT food_id FROM diary_entry WHERE food_id IS NOT NULL) '
      + 'AND id NOT IN (SELECT food_id FROM template_item WHERE food_id IS NOT NULL) AND id NOT IN (SELECT food_id FROM recipe_item WHERE food_id IS NOT NULL)', [batchId])).map((r) => r.id as number);
    for (const id of doomed) await con.run('DELETE FROM food WHERE id = ?', [id]);
    await con.run('UPDATE food SET import_id = NULL WHERE import_id = ?', [batchId]);
    await con.run('DELETE FROM import_batch WHERE id = ?', [batchId]);
    return { entries, weights, water, foods: doomed.length, goal: Boolean(goal), activity, workouts };
  });
}
