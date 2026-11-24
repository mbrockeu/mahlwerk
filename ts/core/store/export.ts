// The rows of ONE user for the personal data export (db.py: export_*), selected column by column so that no secret can slip in.
// `first` and `last` are days (inclusive); `demo` false leaves out rows with the demo flag.
import type { Db, Row } from '../db.ts';
import { badgesEarned } from './badges.ts';

export const exportAccount = (db: Db, userId: number): Promise<Row | undefined> =>
  db.get('SELECT username, display_name, created_at FROM user WHERE id = ?', [userId]);

/** `table`, `columns` and `order` are fixed names of the callers below, never user input. */
const exportDays = (db: Db, table: string, columns: string, userId: number, first: string, last: string, demo: boolean, order: string): Promise<Row[]> =>
  db.all(`SELECT ${columns} FROM ${table} WHERE user_id = ? AND day BETWEEN ? AND ? AND (? OR demo = 0) ORDER BY ${order}`, [userId, first, last, demo ? 1 : 0]);

export async function exportDiary(db: Db, userId: number, first: string, last: string, demo: boolean): Promise<Row[]> {
  const rows = await exportDays(db, 'diary_entry', 'id, day, meal, name, brand, amount, unit, per_100, extra, created_at', userId, first, last, demo, 'day, id');
  return rows.map((r): Row => ({ ...r, per_100: JSON.parse(r.per_100), extra: JSON.parse(r.extra || '{}') }));
}
export const exportWeights = (db: Db, u: number, f: string, l: string, d: boolean) => exportDays(db, 'weight', 'day, kg, body_fat_pct, lean_kg', u, f, l, d, 'day');
export const exportWater = (db: Db, u: number, f: string, l: string, d: boolean) => exportDays(db, 'water', 'day, ml', u, f, l, d, 'day');
export const exportActivity = (db: Db, u: number, f: string, l: string, d: boolean) => exportDays(db, 'activity_day', 'day, steps, active_kcal, distance_m, source', u, f, l, d, 'day');
export const exportWorkouts = (db: Db, u: number, f: string, l: string, d: boolean) =>
  exportDays(db, 'workout', 'day, started_at, kind, name, minutes, kcal, distance_m, steps, note, source', u, f, l, d, 'day, COALESCE(started_at, 0), id');
export const exportSleep = (db: Db, u: number, f: string, l: string, d: boolean) => exportDays(db, 'sleep_day', 'day, minutes, source', u, f, l, d, 'day');

/** Fasts that started on a day of the range (local time, like the days of everything else); the open one included. */
export const exportFasts = (db: Db, userId: number, first: string, last: string): Promise<Row[]> =>
  db.all("SELECT started_at, ended_at, target_hours FROM fast WHERE user_id = ? AND date(started_at, 'unixepoch', 'localtime') BETWEEN ? AND ? ORDER BY started_at", [userId, first, last]);

const exportItem = (row: Row) => ({ ...row, per_100: JSON.parse(row.per_100), extra: JSON.parse(row.extra || '{}') });

/** The user's meal templates with their items (oldest first). */
export async function exportTemplates(db: Db, userId: number) {
  const rows = await db.all('SELECT id, name, created_at FROM template WHERE user_id = ? ORDER BY id', [userId]);
  const out = [];
  for (const row of rows) {
    const items = await db.all('SELECT name, brand, amount, unit, per_100, extra FROM template_item WHERE template_id = ? ORDER BY id', [row.id]);
    out.push({ name: row.name, created_at: row.created_at, items: items.map(exportItem) });
  }
  return out;
}

/** Recipes this user created (the household shares recipes, but only the author's own are theirs to take away). */
export async function exportRecipes(db: Db, userId: number, demo: boolean) {
  const hide = demo ? '' : " AND NOT COALESCE(json_extract(food.data, '$.demo') = 1, 0)";
  const rows = await db.all('SELECT recipe.id, recipe.portions, recipe.total_weight, recipe.updated_at, food.data AS data FROM recipe '
    + `JOIN food ON food.id = recipe.food_id WHERE recipe.created_by = ?${hide} ORDER BY recipe.id`, [userId]);
  const out = [];
  for (const row of rows) {
    const items = await db.all('SELECT name, brand, amount, unit, per_100, extra FROM recipe_item WHERE recipe_id = ? ORDER BY position', [row.id]);
    const data = row.data ? JSON.parse(row.data) : {};
    out.push({ name: data.name ?? null, portions: row.portions, total_weight: row.total_weight, updated_at: row.updated_at, per_100: data.per_100 ?? null, items: items.map(exportItem) });
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
