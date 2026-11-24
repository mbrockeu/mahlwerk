// Foods, shared by all users (db.py: get_food, list_foods, put_food, update_food, set_food_piece …).
import type { Db, Row } from '../db.ts';
import { toJson } from '../db.ts';
import type { Per100 } from '../nutrition.ts';

/** What a food keeps in its `data` column. */
export interface FoodData {
  name?: string | null; brand?: string | null; quantity?: string | null; serving_size?: string | null;
  serving_quantity?: number | null; unit?: 'g' | 'ml' | null; per_100: Per100; extra?: Record<string, number> | null;
  portions?: number | null; url?: string | null; region?: string | null; demo_account?: boolean; [k: string]: unknown;
}

export interface FoodRow {
  id: number; code: string | null; source: string; found: boolean; data: FoodData | null; fetched_at: number;
  recipe_id: number | null; external_id: string | null; image_hash: string | null; image_origin: string | null;
  image_at: number | null; image_url: string | null; piece_label: string | null; piece_grams: number | null;
  drink: boolean | null; /** who made it (null: the household); an own recipe is its recipe's author's */ owner: number | null;
}

const MAX_SQL_PARAMS = 900; // bound parameters per statement: far below the limit of older SQLite builds (999)
const DEMO_ACCOUNT_FOOD = "json_extract(data, '$.demo_account') = 1";
// A food row together with the recipe it was calculated from (NULL for everything else).
const FOOD_SELECT = 'SELECT food.*, (SELECT recipe.id FROM recipe WHERE recipe.food_id = food.id) AS recipe_id, '
  + '(SELECT recipe.created_by FROM recipe WHERE recipe.food_id = food.id) AS recipe_owner FROM food';

export function foodRow(row: Row): FoodRow {
  return {
    id: row.id, code: row.code, source: row.source, found: Boolean(row.found), data: row.data ? JSON.parse(row.data) : null,
    fetched_at: row.fetched_at, recipe_id: row.recipe_id, external_id: row.external_id, image_hash: row.image_hash,
    image_origin: row.image_origin, image_at: row.image_at, image_url: row.image_url, piece_label: row.piece_label,
    piece_grams: row.piece_grams, drink: row.drink === null ? null : Boolean(row.drink),
    owner: row.created_by ?? row.recipe_owner,
  };
}

/** The sample foods of the demo account do not exist for anybody else (`demoView`: the caller is the demo account). */
const hidden = (food: FoodRow, demoView: boolean): boolean => !demoView && Boolean(food.data?.demo_account);

export async function getFood(db: Db, foodId: number, demoView = false): Promise<FoodRow | undefined> {
  const row = await db.get(`${FOOD_SELECT} WHERE food.id = ?`, [foodId]);
  const food = row ? foodRow(row) : undefined;
  return food && !hidden(food, demoView) ? food : undefined;
}

/** Several foods at once, by id (missing ones are left out); asked in chunks below SQLite's limit of bound parameters. */
export async function getFoods(db: Db, foodIds: number[], demoView = false): Promise<Map<number, FoodRow>> {
  const found = new Map<number, FoodRow>();
  const ids = [...new Set(foodIds)];
  for (let i = 0; i < ids.length; i += MAX_SQL_PARAMS) {
    const chunk = ids.slice(i, i + MAX_SQL_PARAMS);
    for (const row of await db.all(`${FOOD_SELECT} WHERE food.id IN (${chunk.map(() => '?').join(', ')})`, chunk)) {
      const food = foodRow(row);
      if (!hidden(food, demoView)) found.set(food.id, food);
    }
  }
  return found;
}

export async function getFoodByCode(db: Db, code: string): Promise<FoodRow | undefined> {
  const row = await db.get(`${FOOD_SELECT} WHERE food.code = ?`, [code]);
  return row ? foodRow(row) : undefined;
}

/** Known products, newest first. The search looks at name, brand and barcode; `exclude` leaves out sources. The foods of the
 * demo account are listed only for the demo account itself. */
export async function listFoods(db: Db, query = '', source: string | null = null, limit = 50, exclude: string[] = [], demoAccount = false): Promise<FoodRow[]> {
  const hide = demoAccount ? '' : ` AND NOT COALESCE(${DEMO_ACCOUNT_FOOD}, 0)`;
  const rows = await db.all(`${FOOD_SELECT} WHERE food.found = 1${hide} ORDER BY food.fetched_at DESC, food.id DESC`);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const result: FoodRow[] = [];
  for (const row of rows) {
    const food = foodRow(row);
    const data = food.data!;
    if (source && food.source !== source) continue;
    if (exclude.includes(food.source)) continue;
    if (data.name == null && Object.values(data.per_100).every((v) => v == null)) continue; // empty shell
    const haystack = [food.code, data.name, data.brand].filter(Boolean).join(' ').toLowerCase();
    if (words.every((w) => haystack.includes(w))) result.push(food);
    if (result.length >= limit) break;
  }
  return result;
}

/** Insert or, for a known barcode, replace. Returns [id, fetched_at]. `createdBy` becomes the owner of a new food, or of one that
 * was only a remembered miss; a food that exists keeps its owner (the caller checked that the replacing is allowed). */
export async function putFood(db: Db, code: string | null, source: string, data: FoodData | null, createdBy: number | null = null): Promise<[number, number]> {
  const now = Math.floor(Date.now() / 1000);
  return db.tx(async (tx) => {
    await tx.run(
      'INSERT INTO food (code, source, found, data, fetched_at, created_by) VALUES (?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(code) DO UPDATE SET source = excluded.source, found = excluded.found, data = excluded.data, '
      + 'fetched_at = excluded.fetched_at, import_id = NULL, '
      + 'created_by = CASE WHEN food.found = 0 THEN excluded.created_by ELSE food.created_by END',
      [code, source, data !== null ? 1 : 0, data ? toJson(data) : null, now, data ? createdBy : null]);
    const row = code ? await tx.get('SELECT id FROM food WHERE code = ?', [code]) : undefined;
    const id = row ? row.id : (await tx.get('SELECT last_insert_rowid() AS id'))!.id;
    return [id, now];
  });
}

export async function updateFood(db: Db, foodId: number, source: string, data: FoodData): Promise<number | null> {
  const now = Math.floor(Date.now() / 1000);
  const r = await db.run('UPDATE food SET source = ?, found = 1, data = ?, fetched_at = ?, import_id = NULL WHERE id = ?', [source, toJson(data), now, foodId]);
  return r.changes ? now : null;
}

/** Set the piece of a food (both null: remove it). False for an unknown food. */
export async function setFoodPiece(db: Db, foodId: number, label: string | null, grams: number | null): Promise<boolean> {
  return (await db.run('UPDATE food SET piece_label = ?, piece_grams = ? WHERE id = ?', [label, grams, foodId])).changes > 0;
}

/** Set whether a food counts as a drink (null: decide automatically). False for an unknown food. */
export async function setFoodDrink(db: Db, foodId: number, drink: boolean | null): Promise<boolean> {
  return (await db.run('UPDATE food SET drink = ? WHERE id = ?', [drink === null ? null : Number(drink), foodId])).changes > 0;
}

/** Take the picture away. `origin` stays as the marker (`none` = taken away by a person: a reload does not bring it back).
 * Returns the hash it had (null: none), or false for an unknown food. */
export async function clearFoodImage(db: Db, foodId: number, origin: string | null = null): Promise<string | null | false> {
  return db.tx(async (tx) => {
    const row = await tx.get('SELECT image_hash FROM food WHERE id = ?', [foodId]);
    if (!row) return false;
    await tx.run('UPDATE food SET image_hash = NULL, image_origin = ?, image_at = ?, image_url = NULL WHERE id = ?',
      [origin, origin ? Math.floor(Date.now() / 1000) : null, foodId]);
    return row.image_hash;
  });
}

/** Diary entries, template and recipe items keep their copy and lose only the link. */
export async function deleteFood(db: Db, foodId: number): Promise<boolean> {
  return db.tx(async (tx) => {
    for (const table of ['diary_entry', 'template_item', 'recipe_item']) await tx.run(`UPDATE ${table} SET food_id = NULL WHERE food_id = ?`, [foodId]);
    return (await tx.run('DELETE FROM food WHERE id = ?', [foodId])).changes > 0;
  });
}

/** Those of `codes` that exist as a known food (not merely as a remembered miss). */
export async function knownCodes(db: Db, codes: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < codes.length; i += MAX_SQL_PARAMS) {
    const chunk = codes.slice(i, i + MAX_SQL_PARAMS);
    for (const r of await db.all(`SELECT code FROM food WHERE found = 1 AND code IN (${chunk.map(() => '?').join(', ')})`, chunk)) found.add(r.code);
  }
  return found;
}

/** The "source/code" of those catalogue `hits` that exist as a food already: by barcode for packaged products, by `external_id`
 * (`bls:<code>`) for basic foods. */
export async function knownCatalog(db: Db, hits: { source: string; code: string }[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const c of await knownCodes(db, hits.filter((h) => h.source !== 'bls').map((h) => h.code))) out.add(`openfoodfacts/${c}`);
  const keys = hits.filter((h) => h.source === 'bls').map((h) => `bls:${h.code}`);
  for (let i = 0; i < keys.length; i += MAX_SQL_PARAMS) {
    const chunk = keys.slice(i, i + MAX_SQL_PARAMS);
    for (const r of await db.all(`SELECT external_id FROM food WHERE found = 1 AND external_id IN (${chunk.map(() => '?').join(', ')})`, chunk)) {
      out.add(`bls/${String(r.external_id).slice(4)}`);
    }
  }
  return out;
}

export async function getFoodByExternalId(db: Db, externalId: string): Promise<FoodRow | undefined> {
  const row = await db.get(`${FOOD_SELECT} WHERE food.external_id = ?`, [externalId]);
  return row ? foodRow(row) : undefined;
}

/** Insert a food without barcode that is recognised by `external_id`. Returns [id, fetched_at]. */
export async function putExternalFood(db: Db, externalId: string, source: string, data: FoodData, createdBy: number | null = null): Promise<[number, number]> {
  const now = Math.floor(Date.now() / 1000);
  const r = await db.run('INSERT INTO food (code, source, found, data, fetched_at, external_id, created_by) VALUES (NULL, ?, 1, ?, ?, ?, ?)',
    [source, toJson(data), now, externalId, createdBy]);
  return [r.lastId, now];
}
