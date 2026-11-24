// Recipes (shared by all users, like foods), the groups of recipes and what the suggestions and the ingredient finder read
// (db.py: save_recipe, get_recipe, list_recipes, delete_recipe, the recipe_group functions, recipe_foods, last_eaten, eaten_since, known_catalog).
import type { Db, Row } from '../db.ts';
import { toJson } from '../db.ts';
import { getFood, type FoodData, type FoodRow } from './foods.ts';
import { itemRow, type ItemIn, type TemplateItemRow } from './templates.ts';

export interface RecipeRow { id: number; food_id: number; portions: number; total_weight: number | null; created_by: number | null; updated_at: number; food: FoodRow; items: TemplateItemRow[] }

const now = () => Math.floor(Date.now() / 1000);

async function withParts(db: Db, row: Row): Promise<RecipeRow> {
  const items = await db.all('SELECT * FROM recipe_item WHERE recipe_id = ? ORDER BY position', [row.id]);
  return { ...row, food: (await getFood(db, row.food_id, true))!, items: items.map(itemRow) } as RecipeRow;
}

/** Create a recipe with its calculated food, or (with `recipeId`) replace both. null: unknown recipe. */
export async function saveRecipe(db: Db, recipeId: number | null, userId: number, foodData: FoodData, portions: number, totalWeight: number | null, items: ItemIn[]): Promise<number | null> {
  const t = now();
  return db.tx(async (tx) => {
    let id = recipeId;
    if (id === null) {
      const foodId = (await tx.run("INSERT INTO food (code, source, found, data, fetched_at, created_by) VALUES (NULL, 'recipe', 1, ?, ?, ?)", [toJson(foodData), t, userId])).lastId;
      id = (await tx.run('INSERT INTO recipe (food_id, portions, total_weight, created_by, updated_at) VALUES (?, ?, ?, ?, ?)', [foodId, portions, totalWeight, userId, t])).lastId;
    } else {
      const row = await tx.get('SELECT food_id FROM recipe WHERE id = ?', [id]);
      if (!row) return null;
      await tx.run('UPDATE food SET data = ?, fetched_at = ? WHERE id = ?', [toJson(foodData), t, row.food_id]);
      await tx.run('UPDATE recipe SET portions = ?, total_weight = ?, updated_at = ? WHERE id = ?', [portions, totalWeight, t, id]);
      await tx.run('DELETE FROM recipe_item WHERE recipe_id = ?', [id]);
    }
    for (const [position, item] of items.entries()) {
      await tx.run('INSERT INTO recipe_item (recipe_id, position, food_id, amount, unit, name, brand, per_100, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, position, item.food_id, item.amount, item.unit, item.name, item.brand, toJson(item.per_100), toJson(item.extra || {})]);
    }
    return id;
  });
}

export async function getRecipe(db: Db, recipeId: number): Promise<RecipeRow | undefined> {
  const row = await db.get('SELECT * FROM recipe WHERE id = ?', [recipeId]);
  return row ? withParts(db, row) : undefined;
}

/** All recipes, most recently changed first. */
export async function listRecipes(db: Db): Promise<RecipeRow[]> {
  const rows = await db.all('SELECT * FROM recipe ORDER BY updated_at DESC, id DESC');
  return Promise.all(rows.map((r) => withParts(db, r)));
}

/** Remove the recipe and its calculated food; diary entries and templates keep their copies. */
export async function deleteRecipe(db: Db, recipeId: number): Promise<boolean> {
  return db.tx(async (tx) => {
    const row = await tx.get('SELECT food_id FROM recipe WHERE id = ?', [recipeId]);
    if (!row) return false;
    await tx.run('DELETE FROM recipe_item WHERE recipe_id = ?', [recipeId]);
    await tx.run('DELETE FROM recipe WHERE id = ?', [recipeId]);
    for (const table of ['diary_entry', 'template_item', 'recipe_item']) await tx.run(`UPDATE ${table} SET food_id = NULL WHERE food_id = ?`, [row.food_id]);
    await tx.run('DELETE FROM food WHERE id = ?', [row.food_id]);
    return true;
  });
}

// groups of recipes (shared by all users; the members are food ids: own recipes and Cookidoo recipes alike)

export interface GroupRow { id: number; name: string; position: number; source: string | null; created_by: number | null; created_at: number; food_ids: number[] }

/** All groups in their order, each with its member food ids. */
export async function listGroups(db: Db): Promise<GroupRow[]> {
  const groups = (await db.all('SELECT * FROM recipe_group ORDER BY position, id')) as GroupRow[];
  const members = new Map<number, number[]>();
  for (const row of await db.all('SELECT group_id, food_id FROM recipe_group_item ORDER BY food_id')) {
    members.set(row.group_id, [...(members.get(row.group_id) ?? []), row.food_id]);
  }
  return groups.map((g) => ({ ...g, food_ids: members.get(g.id) ?? [] }));
}

export async function getGroup(db: Db, groupId: number): Promise<GroupRow | undefined> {
  return (await listGroups(db)).find((g) => g.id === groupId);
}

export async function groupNameTaken(db: Db, name: string, exceptId: number | null = null): Promise<boolean> {
  return (await db.get('SELECT 1 FROM recipe_group WHERE name = ? COLLATE NOCASE AND id IS NOT ?', [name, exceptId])) !== undefined;
}

export async function createGroup(db: Db, name: string, userId: number): Promise<GroupRow> {
  const id = await db.tx(async (tx) => {
    const position = (await tx.get('SELECT coalesce(max(position), 0) + 1 AS p FROM recipe_group'))!.p;
    return (await tx.run('INSERT INTO recipe_group (name, position, source, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [name, position, null, userId, now()])).lastId;
  });
  return (await getGroup(db, id))!;
}

export async function renameGroup(db: Db, groupId: number, name: string): Promise<boolean> {
  return (await db.run('UPDATE recipe_group SET name = ? WHERE id = ?', [name, groupId])).changes > 0;
}

/** The group goes, its recipes stay. A group that was made from a Cookidoo collection is remembered as dismissed, so the next run does not
 * bring it back unasked. */
export async function deleteGroup(db: Db, groupId: number): Promise<boolean> {
  return db.tx(async (tx) => {
    const row = await tx.get('SELECT source FROM recipe_group WHERE id = ?', [groupId]);
    if (!row) return false;
    if (row.source) await tx.run('INSERT OR IGNORE INTO recipe_group_dismissed (source) VALUES (?)', [row.source]);
    await tx.run('DELETE FROM recipe_group WHERE id = ?', [groupId]);
    return true;
  });
}

/** Put the groups in this order; false unless `ids` lists every group exactly once. */
export async function reorderGroups(db: Db, ids: number[]): Promise<boolean> {
  return db.tx(async (tx) => {
    const known = new Set((await tx.all('SELECT id FROM recipe_group')).map((r) => r.id as number));
    if (ids.length !== new Set(ids).size || ids.length !== known.size || !ids.every((i) => known.has(i))) return false;
    for (const [i, id] of ids.entries()) await tx.run('UPDATE recipe_group SET position = ? WHERE id = ?', [i + 1, id]);
    return true;
  });
}

/** Those of `foodIds` that are recipes (own, from Cookidoo or from a web page), so they may be members of a group. */
export async function recipeFoodIds(db: Db, foodIds: number[]): Promise<Set<number>> {
  if (!foodIds.length) return new Set();
  const rows = await db.all(`SELECT id FROM food WHERE found = 1 AND source IN ('recipe', 'cookidoo', 'web') AND id IN (${foodIds.map(() => '?').join(', ')})`, foodIds);
  return new Set(rows.map((r) => r.id as number));
}

/** Add recipes (food ids) to a group; returns how many were new members. The caller checked the ids. */
export async function addToGroup(db: Db, groupId: number, foodIds: number[]): Promise<number> {
  return db.tx(async (tx) => {
    let added = 0;
    for (const f of foodIds) added += (await tx.run('INSERT OR IGNORE INTO recipe_group_item (group_id, food_id) VALUES (?, ?)', [groupId, f])).changes;
    return added;
  });
}

export async function removeFromGroup(db: Db, groupId: number, foodIds: number[]): Promise<number> {
  return db.tx(async (tx) => {
    let removed = 0;
    for (const f of foodIds) removed += (await tx.run('DELETE FROM recipe_group_item WHERE group_id = ? AND food_id = ?', [groupId, f])).changes;
    return removed;
  });
}

/** The groups this recipe belongs to, exactly these. The caller checked the ids. */
export async function setFoodGroups(db: Db, foodId: number, groupIds: number[]): Promise<void> {
  await db.tx(async (tx) => {
    await tx.run('DELETE FROM recipe_group_item WHERE food_id = ?', [foodId]);
    for (const g of groupIds) await tx.run('INSERT OR IGNORE INTO recipe_group_item (group_id, food_id) VALUES (?, ?)', [g, foodId]);
  });
}

// what the suggestions and the ingredient finder read

/** Every recipe (own, Cookidoo, web) as {id, source, data}, in ONE query; `group` is a group id as text, or `none` for the recipes in no group. */
export async function recipeFoods(db: Db, group: string | null = null): Promise<{ id: number; source: string; data: FoodData }[]> {
  let sql = "SELECT id, source, data FROM food WHERE found = 1 AND source IN ('recipe', 'cookidoo', 'web')";
  const args: number[] = [];
  if (group === 'none') sql += ' AND id NOT IN (SELECT food_id FROM recipe_group_item)';
  else if (group !== null) {
    sql += ' AND id IN (SELECT food_id FROM recipe_group_item WHERE group_id = ?)';
    args.push(Number(group));
  }
  return (await db.all(sql + ' ORDER BY id', args)).map((r) => ({ id: r.id, source: r.source, data: r.data ? JSON.parse(r.data) : {} }));
}

/** food id -> the latest day up to `last` on which this user logged it. */
export async function lastEaten(db: Db, userId: number, last: string): Promise<Map<number, string>> {
  const rows = await db.all('SELECT food_id, MAX(day) AS day FROM diary_entry WHERE user_id = ? AND food_id IS NOT NULL AND day <= ? GROUP BY food_id', [userId, last]);
  return new Map(rows.map((r) => [r.food_id as number, r.day as string]));
}

/** Per food this user logged from `first` on: how many entries and the latest day. */
export async function eatenSince(db: Db, userId: number, first: string): Promise<Map<number, { count: number; last: string }>> {
  const rows = await db.all('SELECT food_id, COUNT(*) AS count, MAX(day) AS last FROM diary_entry WHERE user_id = ? AND day >= ? AND food_id IS NOT NULL GROUP BY food_id', [userId, first]);
  return new Map(rows.map((r) => [r.food_id as number, { count: r.count as number, last: r.last as string }]));
}

/** The (source, code) of those catalogue `hits` that exist as a food already: by barcode for packaged products, by `external_id`
 * (`bls:<code>`) for basic foods. Keys as `skipKey(source, code)` of ingredients.ts. */
export async function knownCatalog(db: Db, hits: { source: string; code: string }[], key: (source: string, code: string) => string): Promise<Set<string>> {
  const out = new Set<string>();
  const codes = hits.filter((h) => h.source !== 'bls').map((h) => h.code);
  if (codes.length) {
    for (const r of await db.all(`SELECT code FROM food WHERE found = 1 AND code IN (${codes.map(() => '?').join(', ')})`, codes)) out.add(key('openfoodfacts', r.code));
  }
  const keys = hits.filter((h) => h.source === 'bls').map((h) => `bls:${h.code}`);
  if (keys.length) {
    for (const r of await db.all(`SELECT external_id FROM food WHERE found = 1 AND external_id IN (${keys.map(() => '?').join(', ')})`, keys)) out.add(key('bls', (r.external_id as string).slice(4)));
  }
  return out;
}
