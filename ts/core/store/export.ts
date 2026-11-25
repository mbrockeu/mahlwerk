// The rows of ONE user for the personal data export (db.py: export_*), selected column by column so that no secret can slip in.
// `first` and `last` are days (inclusive); `demo` false leaves out rows with the demo flag.
import type { Db, Row } from '../db.ts';
import { badgesEarned } from './badges.ts';
import { DEMO_ACCOUNT_FOOD, DEMO_FOOD } from './demo.ts';

export const exportAccount = (db: Db, userId: number): Promise<Row | undefined> =>
  db.get('SELECT username, display_name, created_at FROM user WHERE id = ?', [userId]);

/** `table`, `columns` and `order` are fixed names of the callers below, never user input. */
const exportDays = (db: Db, table: string, columns: string, userId: number, first: string, last: string, demo: boolean, order: string): Promise<Row[]> =>
  db.all(`SELECT ${columns} FROM ${table} WHERE user_id = ? AND day BETWEEN ? AND ? AND (? OR demo = 0) ORDER BY ${order}`, [userId, first, last, demo ? 1 : 0]);

/** The food a row links to, as the export names it: its stable id and its barcode (the import finds the food by either). */
const foodLink = (t: string) => `(SELECT f.uid FROM food f WHERE f.id = ${t}.food_id) AS food_uid, (SELECT f.code FROM food f WHERE f.id = ${t}.food_id) AS food_code`;

export async function exportDiary(db: Db, userId: number, first: string, last: string, demo: boolean): Promise<Row[]> {
  const rows = await exportDays(db, 'diary_entry', `id, uid, day, meal, name, brand, amount, unit, per_100, extra, created_at, external_id, ${foodLink('diary_entry')}`, userId, first, last, demo, 'day, id');
  return rows.map((r): Row => ({ ...r, per_100: JSON.parse(r.per_100), extra: JSON.parse(r.extra || '{}') }));
}
export const exportWeights = async (db: Db, u: number, f: string, l: string, d: boolean) =>
  (await exportDays(db, 'weight', 'day, kg, body_fat_pct, lean_kg, health, body_fat_health, lean_health', u, f, l, d, 'day'))
    .map((r) => ({ ...r, health: Boolean(r.health), body_fat_health: Boolean(r.body_fat_health), lean_health: Boolean(r.lean_health) }));
export const exportWater = async (db: Db, u: number, f: string, l: string, d: boolean) =>
  (await exportDays(db, 'water', 'day, ml, health', u, f, l, d, 'day')).map((r) => ({ ...r, health: Boolean(r.health) }));
export const exportActivity = (db: Db, u: number, f: string, l: string, d: boolean) => exportDays(db, 'activity_day', 'day, steps, active_kcal, distance_m, source', u, f, l, d, 'day');
export const exportWorkouts = (db: Db, u: number, f: string, l: string, d: boolean) =>
  exportDays(db, 'workout', 'uid, day, started_at, kind, name, minutes, kcal, distance_m, steps, note, source, external_id', u, f, l, d, 'day, COALESCE(started_at, 0), id');
export const exportSleep = (db: Db, u: number, f: string, l: string, d: boolean) => exportDays(db, 'sleep_day', 'day, minutes, source', u, f, l, d, 'day');

/** Fasts that started on a day of the range (local time, like the days of everything else); the open one included. */
export const exportFasts = (db: Db, userId: number, first: string, last: string): Promise<Row[]> =>
  db.all("SELECT uid, started_at, ended_at, target_hours FROM fast WHERE user_id = ? AND date(started_at, 'unixepoch', 'localtime') BETWEEN ? AND ? ORDER BY started_at", [userId, first, last]);

const exportItem = (row: Row) => ({ ...row, per_100: JSON.parse(row.per_100), extra: JSON.parse(row.extra || '{}') });

/** The user's meal templates with their items (oldest first). */
export async function exportTemplates(db: Db, userId: number) {
  const rows = await db.all('SELECT id, uid, name, created_at FROM template WHERE user_id = ? ORDER BY id', [userId]);
  const out = [];
  for (const row of rows) {
    const items = await db.all(`SELECT name, brand, amount, unit, per_100, extra, ${foodLink('template_item')} FROM template_item WHERE template_id = ? ORDER BY id`, [row.id]);
    out.push({ uid: row.uid, name: row.name, created_at: row.created_at, items: items.map(exportItem) });
  }
  return out;
}

/** Recipes this user created (the household shares recipes, but only the author's own are theirs to take away). */
export async function exportRecipes(db: Db, userId: number, demo: boolean) {
  const hide = demo ? '' : " AND NOT COALESCE(json_extract(food.data, '$.demo') = 1, 0)";
  const rows = await db.all('SELECT recipe.id, recipe.uid, food.uid AS food_uid, recipe.portions, recipe.total_weight, recipe.updated_at, food.data AS data FROM recipe '
    + `JOIN food ON food.id = recipe.food_id WHERE recipe.created_by = ?${hide} ORDER BY recipe.id`, [userId]);
  const out = [];
  for (const row of rows) {
    const items = await db.all(`SELECT name, brand, amount, unit, per_100, extra, ${foodLink('recipe_item')} FROM recipe_item WHERE recipe_id = ? ORDER BY position`, [row.id]);
    const data = row.data ? JSON.parse(row.data) : {};
    out.push({ uid: row.uid, food_uid: row.food_uid, name: data.name ?? null, portions: row.portions, total_weight: row.total_weight, updated_at: row.updated_at, per_100: data.per_100 ?? null, items: items.map(exportItem) });
  }
  return out;
}

/** The products this user made, and those their diary (in the range), templates, recipes and groups use: shared with the household,
 * but needed to bring the links and the own products along. Never a recipe's calculated food (that is the recipe), a remembered miss,
 * a sample food or a picture. A member of the household (`household`) also gets the recipes the household took over from Cookidoo or a
 * web page (they belong to nobody, so a move would lose them); a guest only what they made or use. */
export async function exportFoods(db: Db, userId: number, first: string, last: string, demo: boolean, household = false) {
  const hide = demo ? '' : ` AND NOT COALESCE(${DEMO_FOOD}, 0) AND NOT COALESCE(${DEMO_ACCOUNT_FOOD}, 0)`;
  const rows = await db.all('SELECT uid, code, source, external_id, data, piece_label, piece_grams, drink, created_by, fetched_at FROM food '
    + `WHERE found = 1 AND source <> 'recipe'${hide} AND (created_by = :u `
    + "OR (:h AND created_by IS NULL AND source IN ('cookidoo', 'web')) "
    + 'OR id IN (SELECT food_id FROM diary_entry WHERE user_id = :u AND day BETWEEN :a AND :b AND (:d OR demo = 0)) '
    + 'OR id IN (SELECT i.food_id FROM template_item i JOIN template t ON t.id = i.template_id WHERE t.user_id = :u) '
    + 'OR id IN (SELECT i.food_id FROM recipe_item i JOIN recipe r ON r.id = i.recipe_id WHERE r.created_by = :u) '
    + 'OR id IN (SELECT i.food_id FROM recipe_group_item i JOIN recipe_group g ON g.id = i.group_id WHERE g.created_by = :u)) '
    + 'ORDER BY id', { u: userId, a: first, b: last, d: demo ? 1 : 0, h: household ? 1 : 0 });
  return rows.map((r) => ({
    uid: r.uid, code: r.code, source: r.source, external_id: r.external_id, data: JSON.parse(r.data), piece_label: r.piece_label,
    piece_grams: r.piece_grams, drink: r.drink === null ? null : Boolean(r.drink), own: r.created_by === userId, fetched_at: r.fetched_at,
  }));
}

/** The recipe groups this user made, with their members as the stable ids of the foods (own and taken-over recipes). */
export async function exportRecipeGroups(db: Db, userId: number) {
  const rows = await db.all('SELECT id, uid, name, position, source, created_at FROM recipe_group WHERE created_by = ? ORDER BY position, id', [userId]);
  const out = [];
  for (const row of rows) {
    const members = await db.all('SELECT f.uid FROM recipe_group_item i JOIN food f ON f.id = i.food_id WHERE i.group_id = ? ORDER BY f.id', [row.id]);
    out.push({ uid: row.uid, name: row.name, position: row.position, source: row.source, created_at: row.created_at, members: members.map((m) => m.uid) });
  }
  return out;
}

export async function exportBadges(db: Db, userId: number, demo: boolean) {
  return (await badgesEarned(db, userId)).filter((b) => demo || !b.demo).map((b) => ({ code: b.code, earned_at: b.earned_at }));
}

/** Name, events and switch of the hooks. The address is only partly given (see core/export.ts) and the secret never. */
export async function exportWebhooks(db: Db, userId: number) {
  const rows = await db.all('SELECT name, url, events, enabled, created_at FROM webhook WHERE user_id = ? ORDER BY id', [userId]);
  return rows.map((h) => ({ name: h.name, url: h.url, events: JSON.parse(h.events), enabled: Boolean(h.enabled), created_at: h.created_at }));
}
