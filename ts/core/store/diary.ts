// The diary of a user (db.py: add_entry, entries_on, entries_between, recent_foods, drink_entries …).
import type { Db, Row } from '../db.ts';
import { toJson } from '../db.ts';
import type { Per100 } from '../nutrition.ts';

export interface EntryRow {
  id: number; user_id: number; day: string; meal: string; food_id: number | null; amount: number; unit: 'g' | 'ml'; name: string;
  brand: string | null; per_100: Per100; created_at: number; demo: number; extra: Record<string, number>;
  external_id: string | null; import_id: number | null;
}

/** The stored copy of a food an entry (or template item) keeps. */
export interface Snapshot { unit: string; name: string; brand: string | null; per_100: Per100; extra?: Record<string, number> | null }

const entryRow = (row: Row): EntryRow => ({ ...row, per_100: JSON.parse(row.per_100), extra: JSON.parse(row.extra || '{}') }) as EntryRow;
const now = () => Math.floor(Date.now() / 1000);

const INSERT = 'INSERT INTO diary_entry (user_id, day, meal, food_id, amount, unit, name, brand, per_100, extra, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

export async function addEntry(db: Db, userId: number, day: string, meal: string, foodId: number, amount: number, copy: Snapshot): Promise<number> {
  const r = await db.run(INSERT, [userId, day, meal, foodId, amount, copy.unit, copy.name, copy.brand, toJson(copy.per_100), toJson(copy.extra ?? {}), now()]);
  return r.lastId;
}

/** Insert several entries in one transaction. Each item has meal, food_id, amount and the snapshot fields. */
export async function addEntries(db: Db, userId: number, day: string, items: (Snapshot & { meal: string; food_id: number | null; amount: number })[]): Promise<number[]> {
  const created = now();
  return db.tx(async (tx) => {
    const ids: number[] = [];
    for (const i of items) {
      ids.push((await tx.run(INSERT, [userId, day, i.meal, i.food_id, i.amount, i.unit, i.name, i.brand, toJson(i.per_100), toJson(i.extra ?? {}), created])).lastId);
    }
    return ids;
  });
}

export async function entriesOn(db: Db, userId: number, day: string, meal: string | null = null): Promise<EntryRow[]> {
  const rows = meal === null
    ? await db.all('SELECT * FROM diary_entry WHERE user_id = ? AND day = ? ORDER BY id', [userId, day])
    : await db.all('SELECT * FROM diary_entry WHERE user_id = ? AND day = ? AND meal = ? ORDER BY id', [userId, day, meal]);
  return rows.map(entryRow);
}

export async function getEntry(db: Db, userId: number, entryId: number): Promise<EntryRow | undefined> {
  const row = await db.get('SELECT * FROM diary_entry WHERE id = ? AND user_id = ?', [entryId, userId]);
  return row ? entryRow(row) : undefined;
}

/** Several entries of the user at once, in the order of `ids` (all must exist). */
export async function getEntries(db: Db, userId: number, ids: number[]): Promise<EntryRow[]> {
  if (!ids.length) return [];
  const rows = await db.all('SELECT * FROM diary_entry WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))', [userId, JSON.stringify(ids)]);
  const byId = new Map(rows.map((r) => [r.id as number, r]));
  return ids.map((i) => entryRow(byId.get(i)!));
}

/** Change amount and meal; with `foodId` and its snapshot `copy` the entry becomes that food (day and created_at stay). */
export async function updateEntry(db: Db, userId: number, entryId: number, amount: number | null, meal: string | null, foodId: number | null = null, copy: Snapshot | null = null): Promise<boolean> {
  return db.tx(async (tx) => {
    const changed = (await tx.run('UPDATE diary_entry SET amount = COALESCE(?, amount), meal = COALESCE(?, meal), import_id = NULL WHERE id = ? AND user_id = ?',
      [amount, meal, entryId, userId])).changes > 0;
    if (changed && foodId !== null && copy !== null) {
      await tx.run('UPDATE diary_entry SET food_id = ?, unit = ?, name = ?, brand = ?, per_100 = ?, extra = ? WHERE id = ? AND user_id = ?',
        [foodId, copy.unit, copy.name, copy.brand, toJson(copy.per_100), toJson(copy.extra ?? {}), entryId, userId]);
    }
    return changed;
  });
}

export async function deleteEntry(db: Db, userId: number, entryId: number): Promise<boolean> {
  return (await db.run('DELETE FROM diary_entry WHERE id = ? AND user_id = ?', [entryId, userId])).changes > 0;
}

export async function entriesBetween(db: Db, userId: number, first: string, last: string): Promise<EntryRow[]> {
  const rows = await db.all('SELECT * FROM diary_entry WHERE user_id = ? AND day BETWEEN ? AND ? ORDER BY day, id', [userId, first, last]);
  return rows.map(entryRow);
}

/** What the history adds up of each entry in the range (by day, then id like entriesBetween): the amount and kcal, protein, carbs and
 * fat per 100 g (one multi-path json_extract: JSON text with the numbers as stored, so the same doubles as parsing the column). */
export async function macrosBetween(db: Db, userId: number, first: string, last: string): Promise<{ day: string; amount: number; per_100: Record<'kcal' | 'protein' | 'carbs' | 'fat', number | null> }[]> {
  const rows = await db.all("SELECT day, amount, json_extract(per_100, '$.kcal', '$.protein', '$.carbs', '$.fat') AS v FROM diary_entry "
    + 'WHERE user_id = ? AND day BETWEEN ? AND ? ORDER BY day, id', [userId, first, last]);
  return rows.map((r) => {
    const [kcal, protein, carbs, fat] = JSON.parse(r.v);
    return { day: r.day, amount: r.amount, per_100: { kcal, protein, carbs, fat } };
  });
}

/** What the curve of one nutrient (`key`, a known key) reads of each entry in the range (by day, then id): the amount, kcal and the
 * value per 100 g (`per_100` holds kcal and `key`) and the further nutrient `key` (`extra` holds it only where the entry has it,
 * also as null). Multi-path json_extract: JSON text with the numbers as stored, so the same doubles as parsing the columns. */
export async function curveBetween(db: Db, userId: number, first: string, last: string, key: string) {
  const path = `$.${key}`;
  const rows = await db.all("SELECT day, amount, json_extract(per_100, '$.kcal', ?) AS p, json_extract(COALESCE(NULLIF(extra, ''), '{}'), ?, ?) AS e, "
    + "json_type(COALESCE(NULLIF(extra, ''), '{}'), ?) IS NOT NULL AS has FROM diary_entry WHERE user_id = ? AND day BETWEEN ? AND ? ORDER BY day, id",
  [path, path, path, path, userId, first, last]);
  return rows.map((r) => {
    const [kcal, value] = JSON.parse(r.p);
    return { day: r.day as string, amount: r.amount as number, per_100: { kcal, [key]: value } as Per100, extra: r.has ? { [key]: JSON.parse(r.e)[0] } : {} };
  });
}

/** Days with at least one entry up to `last`, newest first. */
export async function loggedDaysUntil(db: Db, userId: number, last: string): Promise<string[]> {
  return (await db.all('SELECT DISTINCT day FROM diary_entry WHERE user_id = ? AND day <= ? ORDER BY day DESC', [userId, last])).map((r) => r.day);
}

/** The latest entry of each food this user logged that still exists, newest first. */
export async function recentFoods(db: Db, userId: number, limit: number): Promise<{ food_id: number; amount: number; meal: string }[]> {
  return db.all('SELECT e.food_id, e.amount, e.meal FROM diary_entry e JOIN food f ON f.id = e.food_id AND f.found = 1 '
    + 'WHERE e.id IN (SELECT MAX(id) FROM diary_entry WHERE user_id = ? AND food_id IS NOT NULL GROUP BY food_id) ORDER BY e.id DESC LIMIT ?', [userId, limit]) as any;
}

/** Entries of one meal type from `first` on (day, then entry id) that name a food which still exists: `{day, food_id, amount}`. */
export async function mealRowsSince(db: Db, userId: number, meal: string, first: string): Promise<{ day: string; food_id: number; amount: number }[]> {
  return db.all('SELECT e.day, e.food_id, e.amount FROM diary_entry e JOIN food f ON f.id = e.food_id AND f.found = 1 '
    + 'WHERE e.user_id = ? AND e.meal = ? AND e.day >= ? ORDER BY e.day, e.id', [userId, meal, first]) as any;
}

export interface DrinkEntry {
  day: string; amount: number; name: string; drink?: number | null; per_100: Per100; extra: Record<string, unknown>; food_extra: Record<string, unknown>;
}

/** The entries in ml of a period with what hydration needs: the entry's own values, and what the food says where the entry has
 * none (water content) or a person decided (`drink`). */
export async function drinkEntries(db: Db, userId: number, first: string, last: string): Promise<DrinkEntry[]> {
  const rows = await db.all('SELECT e.day, e.amount, e.name, e.per_100, e.extra, f.drink, json_extract(f.data, \'$.extra\') AS food_extra '
    + 'FROM diary_entry e LEFT JOIN food f ON f.id = e.food_id WHERE e.user_id = ? AND e.day BETWEEN ? AND ? AND e.unit = \'ml\' ORDER BY e.id',
    [userId, first, last]);
  return rows.map((r) => ({ ...r, per_100: JSON.parse(r.per_100), extra: JSON.parse(r.extra || '{}'), food_extra: r.food_extra ? JSON.parse(r.food_extra) : {} }) as DrinkEntry);
}
