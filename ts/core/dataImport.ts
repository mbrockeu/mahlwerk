// Import of a Mahlwerk data export (export.ts, format 1 or 2) into the caller's own account: moving between the server and the app, a
// new device, a backup brought back. TS only (the live server and the app); the Python server has no such route.
//
// - "merge" (the default) deletes nothing. Rows are matched by their stable id (`uid`, format 2) or their natural key: diary entries and
//   workouts also by `external_id`, weights, water, activity and sleep by day, the goal history by `valid_from`, badges by code; shared
//   products by barcode, then the id they had at the provider (`external_id`), then uid; recipe groups by their Cookidoo link, then
//   their name (case-insensitive), then uid. The same row with other content: the FILE wins. For shared rows (products, recipes, groups)
//   only where the caller may change that row under the rules of the normal edit routes (ownership.ts); otherwise the row stays as it
//   is and is counted as skipped. Rows of other people are never changed or deleted.
// - "replace" first deletes the caller's OWN per-user data (diary, weights, water, activity, sleep, workouts, fasts, templates, goal and
//   its history, the settings of the settings page, badges, Yazio import batches), never shared rows, sign-in, keys, webhooks or stored
//   secrets; then it imports like merge. Refused for a file that holds only a period (`range`): it would delete everything else.
// - Format 1 (before stable ids) can only be told apart from what is there by guessing: replace, or merge into an account that holds no
//   data of its own yet.
// - Not imported: webhooks (their secret is not in the file), pictures, the account itself.
// - Preview and import run the same code (`runImport`); the preview writes nothing. The import is one transaction, the existing rows
//   are read once per table up front, new rows of the long tables are written in batches.
import { z } from 'zod';
import { CODES as BADGE_CODES } from './badges.ts';
import { dayToDate, today } from './dates.ts';
import { toJson, type Db, type Row } from './db.ts';
import { SINCE_START } from './goals.ts';
import { daysGoalIn } from './models/body.ts';
import type { User } from './http.ts';
import { MEALS } from './models/common.ts';
import * as nutrients from './nutrients.ts';
import { foodIn } from './models/food.ts';
import { recipeFood, validGtin } from './nutrition.ts';
import { pyLen } from './text.ts';
import { canEdit } from './ownership.ts';
import { SETTINGS, SETTING_KEYS } from './routes/profile.ts';
import { goalOf, scheduleFrom, scheduleOf } from './store/goals.ts';
import { MAX_GROUPS } from './models/recipe.ts';
import { StageError, structure, unzip } from './yazioStage.ts';
import { tokenUrlsafe } from './crypto.ts';

export const JSON_NAME = 'mahlwerk-export.json';
export const FORMATS = [1, 2];
export const MAX_JSON = 48 * 1024 * 1024; // unpacked; a diary of 15,000 entries is about 20 MB
export const MAX_CONTAINERS = 400_000; // `{`/`[` (15,000 entries: about 64,000)
export const MAX_TOKENS = 4_000_000; // `,`/`:` (15,000 entries: about 1,550,000)
export const MAX_STAGED = 128 * 1024 * 1024; // all waiting files of the server together
export const TTL = 1200; // seconds a waiting file is kept
const BATCH = 400; // rows per INSERT … SELECT FROM json_each(?)

// --- reading the file ----------------------------------------------------------------------------------------------------------------

/** The JSON of the export from the upload: the ZIP the export route gives (only `mahlwerk-export.json` is read) or that file itself.
 * Size, packing density and structure are limited before anything is parsed. Throws StageError. */
export async function decodeImport(body: Uint8Array): Promise<Uint8Array> {
  if (!body.length) throw new StageError('empty', 'the file is empty');
  let json: Uint8Array;
  if (body.length >= 4 && body[0] === 0x50 && body[1] === 0x4b && body[2] === 3 && body[3] === 4) {
    const files = await unzip(body, [JSON_NAME], MAX_JSON, MAX_JSON);
    if (!files[JSON_NAME]) throw new StageError('bad_zip', `the ZIP holds no ${JSON_NAME}: choose the file of a Mahlwerk data export`);
    json = files[JSON_NAME];
  } else {
    if (body.length > MAX_JSON) throw new StageError('too_large', 'the file is larger than allowed');
    json = body;
  }
  const [containers, tokens] = structure(json);
  if (containers > MAX_CONTAINERS || tokens > MAX_TOKENS) throw new StageError('too_large', 'the file holds more entries than an export can have');
  return json;
}

/** The file cannot be imported; the text is safe to show (no content of the file in it). */
export class ImportError extends Error {}

const uid = z.string().regex(/^[0-9a-f]{32}$/);
const day = z.string().refine((d) => d === SINCE_START || dayToDate(d) !== null, 'not a day');
const iso = z.string().max(40).refine((s) => /^\d{4}-\d\d-\d\dT/.test(s) && !Number.isNaN(Date.parse(s)), 'not a time');
const text = (max: number) => z.string().max(max);
const num = (min: number, max: number) => z.number().min(min).max(max);
/** A name or brand as the stores keep it: no limit there (products from Open Food Facts and Yazio can be long); only absurd lengths are
 * refused, everything else is taken as it is. */
const NAME = 10_000;
/** Values per 100 g/ml: what is not a number is read as unknown (null), like the views read it. */
const per100 = z.record(text(60), z.unknown()).refine((o) => Object.keys(o).length <= 100)
  .transform((o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' && Number.isFinite(v) ? v : null])));
/** Further nutrients: cleaned like nutrients.clean on every write (unknown keys, text, null, implausible values are dropped). */
const extra = z.unknown().transform((o) => nutrients.clean(o));
const link = { food_uid: uid.nullable().optional(), food_code: text(64).nullable().optional() };
const item = z.object({ name: text(NAME), brand: text(NAME).nullable().optional(), amount: num(0, 1e6), unit: z.enum(['g', 'ml']), per_100: per100, extra: extra.optional(), ...link });
/** toJson refuses NaN/infinity (a 1e999 in the file): such a value makes the row invalid (422), never a server error. */
const storable = (v: unknown, max: number): boolean => { try { return toJson(v).length <= max; } catch { return false; } };
const ACTIVITY_SOURCES = ['manual', 'health', 'yazio', 'demo'] as const;
const FOOD_SOURCES = ['own', 'openfoodfacts', 'recipe', 'yazio', 'bls', 'cookidoo', 'web'] as const;
/** The keys a food's data has (own products, Open Food Facts, the catalogue, Yazio, Cookidoo, web recipes, sample foods); any other key
 * of the file is dropped. The types are checked per row (`foodProblem`). */
const FOOD_KEYS = new Set(['name', 'brand', 'quantity', 'serving_size', 'serving_quantity', 'unit', 'per_100', 'extra', 'complete', 'portions', 'url',
  'region', 'whole', 'demo', 'demo_account']);
const foodData = z.looseObject({ name: text(NAME).nullable().optional(), per_100: per100 }).refine((d) => storable(d, 200_000), 'too large or not a number')
  .transform((d) => Object.fromEntries(Object.entries(d).filter(([k]) => FOOD_KEYS.has(k))) as { name?: string | null; per_100: Record<string, number | null>; [k: string]: unknown });

const fileSchema = z.object({
  format_version: z.number(),
  exported_at: z.string().max(40).nullable().optional(),
  app_version: z.string().max(40).nullable().optional(),
  range: z.object({ from: day.nullable().optional(), to: day.nullable().optional() }).nullable().optional(),
  account: z.object({ username: text(200).nullable().optional(), display_name: text(200).nullable().optional() }).nullable().optional(),
  goal: z.object({ kcal: num(0, 50000), protein: num(0, 5000), carbs: num(0, 5000), fat: num(0, 5000), water_ml: num(0, 100000).nullable().optional(), steps: num(0, 1e6).nullable().optional(), days_goal: daysGoalIn.nullable().optional() }).nullable().optional(),
  goal_history: z.array(z.object({ valid_from: day, kcal: num(0, 50000), protein: num(0, 5000), carbs: num(0, 5000), fat: num(0, 5000), water_ml: num(0, 100000).nullable().optional(), steps: num(0, 1e6).nullable().optional(), days_goal: daysGoalIn.nullable().optional(), changed_at: iso.nullable().optional() })).max(5000).default([]),
  settings: z.record(text(60), z.unknown()).nullable().optional().refine((v) => storable(v ?? {}, 1_000_000), 'not storable'),
  diary: z.array(z.object({
    uid: uid.optional(), day, meal: z.enum(MEALS), name: text(NAME), brand: text(NAME).nullable().optional(), amount: num(0, 1e6), unit: z.enum(['g', 'ml']),
    logged_at: iso.nullable().optional(), per_100: per100, extra_per_100: extra.optional(), external_id: text(200).nullable().optional(), ...link,
  })).default([]),
  weight: z.array(z.object({ day, kg: num(0, 1000), body_fat_pct: num(0, 100).nullable().optional(), lean_kg: num(0, 1000).nullable().optional(), health: z.boolean().optional(), body_fat_health: z.boolean().optional(), lean_health: z.boolean().optional() })).default([]),
  activity: z.array(z.object({ day, steps: num(0, 1e7).nullable().optional(), active_kcal: num(0, 1e6).nullable().optional(), distance_m: num(0, 1e8).nullable().optional(), source: z.enum(ACTIVITY_SOURCES) })).default([]),
  sleep: z.array(z.object({ day, minutes: z.number().int().min(0).max(100000), source: z.enum(['manual', 'health', 'demo']) })).default([]),
  workouts: z.array(z.object({
    uid: uid.optional(), day, started_at: iso.nullable().optional(), kind: text(60), name: text(NAME), minutes: num(0, 1e6), kcal: num(0, 1e6).nullable().optional(),
    distance_m: num(0, 1e8).nullable().optional(), steps: num(0, 1e8).nullable().optional(), note: text(NAME).nullable().optional(), source: z.enum(ACTIVITY_SOURCES),
    external_id: text(200).nullable().optional(),
  })).default([]),
  water: z.array(z.object({ day, ml: z.number().int().min(0).max(100000), health: z.boolean().optional() })).default([]),
  fasting: z.array(z.object({ uid: uid.optional(), started_at: iso, ended_at: iso.nullable().optional(), target_hours: num(0, 10000) })).default([]),
  templates: z.array(z.object({ uid: uid.optional(), name: text(NAME), created_at: iso.nullable().optional(), items: z.array(item).max(500) })).default([]),
  recipes: z.array(z.object({
    uid: uid.optional(), food_uid: uid.optional(), name: text(NAME).nullable(), portions: z.number().gt(0).max(10000), total_weight: z.number().gt(0).max(1e6).nullable().optional(),
    updated_at: iso.nullable().optional(), items: z.array(item).max(500),
    drink: z.boolean().nullable().optional(), piece_label: text(60).nullable().optional(), piece_grams: z.number().gt(0).max(100000).nullable().optional(),
  })).default([]),
  recipe_groups: z.array(z.object({ uid, name: text(200).min(1), source: text(200).nullable().optional(), created_at: iso.nullable().optional(), members: z.array(uid).max(10000) })).default([]),
  foods: z.array(z.object({
    uid, code: text(64).nullable().optional(), source: z.enum(FOOD_SOURCES), external_id: text(300).nullable().optional(), data: foodData,
    piece_label: text(60).nullable().optional(), piece_grams: z.number().gt(0).max(100000).nullable().optional(), drink: z.boolean().nullable().optional(), own: z.boolean().optional(),
    fetched_at: iso.nullable().optional(),
  })).default([]),
  badges: z.array(z.object({ code: text(60), earned_at: iso.nullable().optional() })).default([]),
  webhooks: z.array(z.unknown()).default([]),
});
export type ExportFile = z.output<typeof fileSchema>;

function noDuplicates<T>(rows: T[], key: (r: T) => string | null | undefined, what: string): void {
  const seen = new Set<string>();
  for (const r of rows) {
    const k = key(r);
    if (k === null || k === undefined) continue;
    if (seen.has(k)) throw new ImportError(`${what} appears twice in the file`);
    seen.add(k);
  }
}

/** Parse and check the JSON of an export: format, every row, no key twice. Throws ImportError (422). */
export function parseExport(json: Uint8Array): ExportFile {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(json)); } catch {
    throw new ImportError('the file is not valid JSON in UTF-8');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ImportError('the file is not a Mahlwerk data export');
  const version = (value as Record<string, unknown>).format_version;
  if (typeof version !== 'number' || !('diary' in value)) throw new ImportError('the file is not a Mahlwerk data export');
  if (!FORMATS.includes(version)) throw new ImportError(`the file has export format ${Math.trunc(version)}; this version reads formats ${FORMATS.join(' and ')}`);
  const parsed = fileSchema.safeParse(value);
  if (!parsed.success) {
    const where = (parsed.error.issues[0]?.path ?? []).map((p, i) => (typeof p === 'number' ? `[${p}]` : `${i ? '.' : ''}${String(p)}`)).join('') || 'file';
    throw new ImportError(`the file is not a valid Mahlwerk data export (${where})`);
  }
  const f = parsed.data;
  if (version >= 2) {
    for (const [name, rows] of [['diary', f.diary], ['workouts', f.workouts], ['fasting', f.fasting], ['templates', f.templates], ['recipes', f.recipes]] as const) {
      if ((rows as { uid?: string }[]).some((r) => !r.uid)) throw new ImportError(`the file is not a valid Mahlwerk data export (${name}.uid)`);
    }
    if (f.recipes.some((r) => !r.food_uid)) throw new ImportError('the file is not a valid Mahlwerk data export (recipes.food_uid)');
  }
  noDuplicates(f.diary, (r) => r.uid, 'a diary entry');
  noDuplicates(f.diary, (r) => r.external_id, 'an id of a diary entry');
  noDuplicates(f.workouts, (r) => r.uid, 'a workout');
  noDuplicates(f.workouts, (r) => r.external_id, 'an id of a workout');
  noDuplicates(f.fasting, (r) => r.uid, 'a fast');
  noDuplicates(f.templates, (r) => r.uid, 'a template');
  noDuplicates(f.recipes, (r) => r.uid, 'a recipe');
  noDuplicates([...f.recipes.map((r) => r.food_uid), ...f.foods.map((x) => x.uid)], (u) => u, 'a product');
  noDuplicates(f.foods, (r) => r.code, 'a barcode');
  noDuplicates(f.foods, (r) => r.external_id, 'a product id');
  noDuplicates(f.recipe_groups, (r) => r.uid, 'a recipe group');
  noDuplicates(f.recipe_groups, (r) => asciiLower(r.name), 'a recipe group name');
  noDuplicates(f.recipe_groups, (r) => r.source, 'a recipe group link');
  for (const [name, rows] of [['weight', f.weight], ['water', f.water], ['activity', f.activity], ['sleep', f.sleep]] as const) noDuplicates(rows as { day: string }[], (r) => r.day, `a day of ${name}`);
  noDuplicates(f.goal_history, (r) => r.valid_from, 'a goal change');
  noDuplicates(f.badges, (r) => r.code, 'a badge');
  if (f.fasting.filter((x) => !x.ended_at).length > 1) throw new ImportError('the file holds more than one running fast');
  return f;
}

// --- counting ---------------------------------------------------------------------------------------------------------------------------

export const KINDS = ['foods', 'recipes', 'recipe_groups', 'diary', 'templates', 'weight', 'water', 'activity', 'sleep', 'workouts', 'fasting',
  'goal', 'goal_history', 'settings', 'badges', 'webhooks'] as const;
export type Kind = (typeof KINDS)[number];
export interface Count { new: number; changed: number; unchanged: number; skipped: number; reasons: Record<string, number> }
export type Counts = Record<Kind, Count>;
export type Mode = 'merge' | 'replace';

const emptyCounts = (): Counts => Object.fromEntries(KINDS.map((k) => [k, { new: 0, changed: 0, unchanged: 0, skipped: 0, reasons: {} }])) as Counts;

/** The kinds whose rows replace deletes (per-user, of the caller only), with the table they live in. */
const OWN_TABLES: [Kind | 'imports', string][] = [
  ['diary', 'diary_entry'], ['weight', 'weight'], ['water', 'water'], ['activity', 'activity_day'], ['sleep', 'sleep_day'], ['workouts', 'workout'],
  ['fasting', 'fast'], ['templates', 'template'], ['goal', 'goal'], ['goal_history', 'goal_history'], ['badges', 'badge_earned'], ['imports', 'import_batch'],
];
const settingKeysSql = () => `(${SETTING_KEYS.map((k) => `'${k}'`).join(', ')})`; // fixed names of the settings schema

/** How many rows of the caller's own data replace would delete. */
export async function ownCounts(db: Db, userId: number): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [kind, table] of OWN_TABLES) out[kind] = (await db.get(`SELECT count(*) AS n FROM ${table} WHERE user_id = ?`, [userId]))!.n;
  out.settings = (await db.get(`SELECT count(*) AS n FROM user_setting WHERE user_id = ? AND key IN ${settingKeysSql()}`, [userId]))!.n;
  return out;
}

async function deleteOwn(db: Db, userId: number): Promise<void> {
  // the products a Yazio batch of this person made stay (shared), but lose the batch: its id may be given to a later batch, whose
  // removal would otherwise take them along
  await db.run('UPDATE food SET import_id = NULL WHERE import_id IN (SELECT id FROM import_batch WHERE user_id = ?)', [userId]);
  await db.run('DELETE FROM template_item WHERE template_id IN (SELECT id FROM template WHERE user_id = ?)', [userId]);
  for (const [, table] of OWN_TABLES) await db.run(`DELETE FROM ${table} WHERE user_id = ?`, [userId]);
  await db.run(`DELETE FROM user_setting WHERE user_id = ? AND key IN ${settingKeysSql()}`, [userId]);
}

/** Whether replace and merge may run for this file and account, and why not. */
export function modesAllowed(f: ExportFile, own: Record<string, number>): Record<Mode, string | null> {
  const ranged = Boolean(f.range?.from || f.range?.to);
  // the rows a format-1 file has no ids for: merging would double them (a goal, settings and badges are merged by their key)
  const hasData = ['diary', 'weight', 'water', 'activity', 'sleep', 'workouts', 'fasting', 'templates'].some((k) => (own[k] ?? 0) > 0);
  return {
    merge: f.format_version < 2 && hasData ? 'old_format' : null,
    replace: ranged ? 'ranged' : null,
  };
}

// --- helpers ------------------------------------------------------------------------------------------------------------------------

/** JSON with the keys sorted: two values with the same content give the same text. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const same = (a: unknown, b: unknown) => canon(a) === canon(b);
const seconds = (s: string | null | undefined): number | null => (s ? Math.floor(Date.parse(s) / 1000) : null);
/** A time of the file that says when something was made or changed: never later than now (a future time would make a row look newer
 * than every later change, or fresh for ever). Uses the wall clock, not the run's: a file's times come from real clocks. */
const past = (s: string | null | undefined): number | null => {
  const t = seconds(s);
  return t === null ? null : Math.min(t, Math.floor(Date.now() / 1000));
};
const parseJson = (s: string | null) => (s ? JSON.parse(s) : {});
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase()); // COLLATE NOCASE
const flag = (b: boolean | undefined) => (b ? 1 : 0);

/** Several rows in one statement: `INSERT INTO t (cols) SELECT json_extract(value, '$[0]'), … FROM json_each(?)`. */
async function insertMany(db: Db, table: string, cols: string[], rows: unknown[][]): Promise<void> {
  const select = cols.map((_, i) => `json_extract(value, '$[${i}]')`).join(', ');
  for (let at = 0; at < rows.length; at += BATCH) {
    await db.run(`INSERT INTO ${table} (${cols.join(', ')}) SELECT ${select} FROM json_each(?)`, [toJson(rows.slice(at, at + BATCH))]);
  }
}

const json = (values: unknown[]) => toJson([...new Set(values.filter((v) => v !== null && v !== undefined))]);
const recipeSources = new Set(['recipe', 'cookidoo', 'web']);

interface Run { db: Db; user: User; f: ExportFile; mode: Mode; write: boolean; counts: Counts; warnings: Record<string, number>; now: number }
const count = (r: Run, kind: Kind, what: 'new' | 'changed' | 'unchanged') => { r.counts[kind][what]++; };
const skip = (r: Run, kind: Kind, reason: string) => { r.counts[kind].skipped++; r.counts[kind].reasons[reason] = (r.counts[kind].reasons[reason] ?? 0) + 1; };
const warn = (r: Run, code: string, n = 1) => { r.warnings[code] = (r.warnings[code] ?? 0) + n; };

// --- shared rows: products, recipes, groups -----------------------------------------------------------------------------------------

interface Foods { byUid: Map<string, number>; byCode: Map<string, number>; source: Map<number, string>; takenUids: Set<string>; nextFake: number }

/** Products: matched by barcode, then provider id, then uid. Fills the map from the file's ids and barcodes to local food ids. */
async function importFoods(r: Run): Promise<Foods> {
  const { db, f, user } = r;
  const itemLinks = [...f.diary, ...f.templates.flatMap((t) => t.items), ...f.recipes.flatMap((x) => x.items)];
  const uids = [...f.foods.map((x) => x.uid), ...f.recipes.map((x) => x.food_uid), ...f.recipe_groups.flatMap((g) => g.members), ...itemLinks.map((i) => i.food_uid)];
  const codes = [...f.foods.map((x) => x.code), ...itemLinks.map((i) => i.food_code)];
  const rows = await db.all('SELECT id, uid, code, source, found, data, fetched_at, piece_label, piece_grams, drink, external_id, created_by, '
    + '(SELECT recipe.created_by FROM recipe WHERE recipe.food_id = food.id) AS recipe_owner FROM food '
    + 'WHERE uid IN (SELECT value FROM json_each(?)) OR code IN (SELECT value FROM json_each(?)) OR external_id IN (SELECT value FROM json_each(?))',
  [json(uids), json(codes), json(f.foods.map((x) => x.external_id))]);
  const local = { uid: new Map<string, Row>(), code: new Map<string, Row>(), ext: new Map<string, Row>() };
  const m: Foods = { byUid: new Map(), byCode: new Map(), source: new Map(), takenUids: new Set(), nextFake: -1 };
  for (const row of rows) {
    if (row.uid) { local.uid.set(row.uid, row); m.byUid.set(row.uid, row.id); m.takenUids.add(row.uid); }
    if (row.code) { local.code.set(row.code, row); m.byCode.set(row.code, row.id); }
    if (row.external_id) local.ext.set(row.external_id, row);
    if (row.found) m.source.set(row.id, row.source);
  }
  for (const x of f.foods) {
    if (x.source === 'recipe') { skip(r, 'foods', 'recipe_food'); continue; } // a recipe comes with its recipe
    // sample foods (of the test data or the demo account) never become real products: skipped, their entries keep their values
    if (isSample(x.data)) { skip(r, 'foods', 'demo'); continue; }
    const problem = foodProblem(x);
    if (problem) { skip(r, 'foods', problem); continue; } // its entries keep their values, without the link
    // a guest brings in only own products: a product of a provider is shared (the household's), which a guest cannot create or turn
    // an own one into (the routes give a guest's lookup to the household too)
    const sharedByGuest = x.source !== 'own' && !user.household;
    const data = foodView(x.data);
    const changedAt = past(x.fetched_at) ?? r.now;
    const want = { source: x.source, data, piece_label: x.piece_label ?? null, piece_grams: x.piece_grams ?? null, drink: x.drink ?? null };
    // the id of a provider (bls:, web:, cookidoo:, yazio:) still matches an existing row, but a NEW own product of a guest is stored
    // without it: that id is the key by which the household's catalogue, web and Cookidoo take-overs find their row
    const externalId = x.external_id ?? null;
    const row = (x.code ? local.code.get(x.code) : undefined) ?? (externalId ? local.ext.get(externalId) : undefined) ?? local.uid.get(x.uid);
    if (row) {
      m.byUid.set(x.uid, row.id);
      if (row.source === 'recipe') { skip(r, 'foods', 'recipe_food'); continue; }
      const stored = parseJson(row.data);
      if (row.found && isSample(stored)) { skip(r, 'foods', 'demo'); continue; } // a sample food here is never overwritten
      const have = { source: row.source, data: foodView(stored), piece_label: row.piece_label, piece_grams: row.piece_grams, drink: row.drink === null ? null : Boolean(row.drink) };
      if (row.found && same(have, want)) { count(r, 'foods', 'unchanged'); continue; }
      if (sharedByGuest) { skip(r, 'foods', 'guest_shared'); continue; }
      if (row.found && !canEdit(user, row.created_by ?? row.recipe_owner)) { skip(r, 'foods', 'not_editable'); continue; }
      // shared: changed here after the file's version was made, the change here stays (a remembered miss is no change)
      if (row.found && (x.fetched_at ? row.fetched_at > changedAt : true)) { skip(r, 'foods', 'newer_here'); continue; }
      count(r, 'foods', 'changed');
      m.source.set(row.id, x.source);
      if (r.write) {
        await db.run('UPDATE food SET source = ?, found = 1, data = ?, fetched_at = ?, import_id = NULL, piece_label = ?, piece_grams = ?, drink = ?, '
          + 'created_by = CASE WHEN found = 0 THEN ? ELSE created_by END WHERE id = ?',
        [x.source, toJson(data), changedAt, want.piece_label, want.piece_grams, want.drink === null ? null : flag(want.drink), ownerOf(x, user), row.id]);
      }
      continue;
    }
    if (sharedByGuest) { skip(r, 'foods', 'guest_shared'); continue; }
    count(r, 'foods', 'new');
    const owner = ownerOf(x, user);
    const newUid = m.takenUids.has(x.uid) ? null : x.uid;
    let id = m.nextFake--;
    if (r.write) {
      id = (await db.run('INSERT INTO food (uid, code, source, found, data, fetched_at, external_id, piece_label, piece_grams, drink, created_by) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)',
        [newUid, x.code ?? null, x.source, toJson(data), changedAt, user.household ? externalId : null, want.piece_label, want.piece_grams, want.drink === null ? null : flag(want.drink), owner])).lastId;
    }
    if (newUid) m.takenUids.add(newUid);
    m.byUid.set(x.uid, id);
    if (x.code) m.byCode.set(x.code, id);
    m.source.set(id, x.source);
  }
  return m;
}

const isText = (v: unknown, max: number) => v === null || (typeof v === 'string' && v.length <= max);
const isNumber = (v: unknown, min: number, max: number) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max);
/** The source id a product of each source carries (an own product keeps the one of the source it was made from). */
const EXTERNAL: Record<string, RegExp | null> = {
  own: /^(?:cookidoo|web|bls|yazio):/, openfoodfacts: null, bls: /^bls:/, cookidoo: /^cookidoo:r\d{3,10}$/, web: /^web:/, yazio: /^yazio:/,
};
type FileFood = z.output<typeof fileSchema>['foods'][number];

/** Why a product of the file is not taken (`invalid`), else null: every field of the data has the type the stores write (a brand that is
 * no text, a unit that is not g/ml …), an own product passes the checks of the food input (FoodIn: lengths, value ranges), the barcode is
 * a valid EAN/UPC (a Yazio product: digits only, as its import keeps them) and the source id fits the source. */
function foodProblem(x: FileFood): string | null {
  const d = x.data as Record<string, unknown>;
  const has = (k: string) => k in d && d[k] !== undefined;
  for (const k of ['brand', 'quantity', 'serving_size', 'url']) if (has(k) && !isText(d[k], NAME)) return 'invalid';
  if (has('serving_quantity') && !isNumber(d.serving_quantity, 0, 1e6)) return 'invalid';
  if (has('portions') && !isNumber(d.portions, 0, 10_000)) return 'invalid';
  if (has('unit') && d.unit !== null && d.unit !== 'g' && d.unit !== 'ml') return 'invalid';
  for (const k of ['complete', 'whole']) if (has(k) && typeof d[k] !== 'boolean') return 'invalid';
  if (has('region') && d.region !== null && !(Array.isArray(d.region) && d.region.length === 2 && d.region.every((v) => typeof v === 'string' && v.length <= 20))) return 'invalid';
  if (x.code && !(validGtin(x.code) || (x.source === 'yazio' && /^\p{Nd}+$/u.test(x.code) && pyLen(x.code) <= 14))) return 'invalid';
  const ext = EXTERNAL[x.source];
  if (x.external_id && !(ext && ext.test(x.external_id))) return 'invalid';
  if (x.source === 'own') {
    const own = foodIn.safeParse({ name: d.name, brand: d.brand, quantity: d.quantity, serving_size: d.serving_size, serving_quantity: d.serving_quantity,
      unit: d.unit ?? undefined, per_100: d.per_100, extra: {} });
    if (!own.success) return 'invalid';
  }
  return null;
}

/** Who a product the import creates belongs to: an own product of the file is the importer's (a guest's own product always is); any
 * other source belongs to the household (created_by NULL), like a product looked up by barcode or taken over from a recipe page. */
const ownerOf = (x: FileFood, user: User): number | null => (x.source === 'own' && (x.own || !user.household) ? user.id : null);

/** A sample food: the test data of an own account (`demo`) or the demo account (`demo_account`). */
const isSample = (data: unknown): boolean => {
  const d = (data ?? {}) as Record<string, unknown>;
  return d.demo === true || d.demo === 1 || d.demo_account === true || d.demo_account === 1;
};
/** The food data as it is written (and so compared): further nutrients cleaned. */
const foodView = (data: unknown): Record<string, unknown> => {
  const d = { ...((data ?? {}) as Record<string, unknown>) };
  if (d.extra !== undefined) d.extra = nutrients.clean(d.extra);
  return d;
};

const resolve = (m: Foods, foodUid?: string | null, code?: string | null): number | null =>
  (foodUid ? m.byUid.get(foodUid) : undefined) ?? (code ? m.byCode.get(code) : undefined) ?? null;

type FileItem = z.output<typeof item>;
const per100View = (o: unknown): Record<string, number | null> =>
  Object.fromEntries(Object.entries((o ?? {}) as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'number' && Number.isFinite(v) ? v : null]));
const itemView = (i: { name: string; brand?: string | null; amount: number; unit: string; per_100: unknown; extra?: unknown }) =>
  ({ name: i.name, brand: i.brand ?? null, amount: i.amount, unit: i.unit, per_100: per100View(i.per_100), extra: nutrients.clean(i.extra ?? {}) });
const localItem = (row: Row) => itemView({ name: row.name, brand: row.brand, amount: row.amount, unit: row.unit, per_100: JSON.parse(row.per_100), extra: parseJson(row.extra) });

/** An item's link: a food that is there or comes with the file; never a recipe (a recipe cannot be part of a template's or recipe's food,
 * the routes refuse that too). Unknown in a real write (a placeholder of the preview) is null. */
function itemFood(r: Run, m: Foods, i: FileItem, noRecipe: boolean): number | null {
  const id = resolve(m, i.food_uid, i.food_code);
  if (id === null || (noRecipe && m.source.get(id) === 'recipe')) return null;
  return id;
}

async function writeItems(db: Db, table: 'template_item' | 'recipe_item', parent: number, items: [FileItem, number | null][]): Promise<void> {
  const rows = items.map(([i, foodId], position) => {
    const v = itemView(i);
    return table === 'recipe_item'
      ? [parent, position, foodId, v.amount, v.unit, v.name, v.brand, toJson(v.per_100), toJson(v.extra)]
      : [parent, foodId, v.amount, v.unit, v.name, v.brand, toJson(v.per_100), toJson(v.extra)];
  });
  const cols = table === 'recipe_item' ? ['recipe_id', 'position', 'food_id', 'amount', 'unit', 'name', 'brand', 'per_100', 'extra'] : ['template_id', 'food_id', 'amount', 'unit', 'name', 'brand', 'per_100', 'extra'];
  await insertMany(db, table, cols, rows);
}

/** Recipes: by uid (format 1: an own recipe of the same name). The calculated food is made again from the items, like the edit route does. */
/** Drink flag and piece of a recipe's food, as far as the file names them (an older file without them leaves the stored ones alone). */
const RECIPE_FOOD_KEYS = ['drink', 'piece_label', 'piece_grams'] as const;
const recipeFoodGiven = (x: Record<string, unknown>) => RECIPE_FOOD_KEYS.filter((k) => x[k] !== undefined);

async function importRecipes(r: Run, m: Foods): Promise<void> {
  const { db, f, user } = r;
  const rows = await db.all('SELECT r.id, r.uid, r.food_id, r.portions, r.total_weight, r.created_by, r.updated_at, fo.uid AS food_uid, fo.data, fo.created_by AS food_owner, '
    + 'fo.drink, fo.piece_label, fo.piece_grams '
    + 'FROM recipe r JOIN food fo ON fo.id = r.food_id WHERE r.uid IN (SELECT value FROM json_each(?)) OR r.created_by = ?', [json(f.recipes.map((x) => x.uid)), user.id]);
  const byUid = new Map(rows.filter((x) => x.uid).map((x) => [x.uid as string, x]));
  const byName = new Map(rows.filter((x) => x.created_by === user.id).map((x) => [asciiLower(String(parseJson(x.data).name ?? '')), x]));
  const items = new Map<number, Row[]>();
  for (const it of await db.all(`SELECT * FROM recipe_item WHERE recipe_id IN (${rows.map((x) => Number(x.id)).join(', ') || 'NULL'}) ORDER BY recipe_id, position`)) {
    items.set(it.recipe_id, [...(items.get(it.recipe_id) ?? []), it]);
  }
  const takenRecipeUids = new Set(byUid.keys());
  for (const row of rows) m.source.set(row.food_id, 'recipe');
  for (const x of f.recipes) {
    const row = x.uid ? byUid.get(x.uid) : byName.get(asciiLower(x.name ?? ''));
    const fileItems: [FileItem, number | null][] = x.items.map((i) => [i, itemFood(r, m, i, true)]);
    const data = { ...recipeFood(fileItems.map(([i]) => itemView(i)) as any, x.portions, x.total_weight ?? null), name: x.name };
    const updated = past(x.updated_at) ?? r.now;
    if (row) {
      if (x.food_uid) m.byUid.set(x.food_uid, row.food_id);
      const given = recipeFoodGiven(x);
      const local: Record<string, unknown> = { drink: row.drink === null ? null : Boolean(row.drink), piece_label: row.piece_label, piece_grams: row.piece_grams };
      const have = { name: parseJson(row.data).name ?? null, portions: row.portions, total_weight: row.total_weight, items: (items.get(row.id) ?? []).map(localItem),
        ...Object.fromEntries(given.map((k) => [k, local[k]])) };
      const want = { name: x.name, portions: x.portions, total_weight: x.total_weight ?? null, items: x.items.map(itemView), ...Object.fromEntries(given.map((k) => [k, x[k]])) };
      if (isSample(parseJson(row.data))) { skip(r, 'recipes', 'demo'); continue; }
      if (same(have, want)) { count(r, 'recipes', 'unchanged'); continue; }
      if (!canEdit(user, row.food_owner ?? row.created_by)) { skip(r, 'recipes', 'not_editable'); continue; }
      if (row.updated_at > (past(x.updated_at) ?? 0)) { skip(r, 'recipes', 'newer_here'); continue; } // changed here after the file's version
      count(r, 'recipes', 'changed');
      if (r.write) {
        const sets = given.map((k) => `, ${k} = ?`).join('');
        await db.run(`UPDATE food SET data = ?, fetched_at = ?${sets} WHERE id = ?`,
          [toJson(data), updated, ...given.map((k) => (k === 'drink' ? (x.drink === null ? null : flag(x.drink)) : x[k]) as string | number | null), row.food_id]);
        await db.run('UPDATE recipe SET portions = ?, total_weight = ?, updated_at = ? WHERE id = ?', [x.portions, x.total_weight ?? null, updated, row.id]);
        await db.run('DELETE FROM recipe_item WHERE recipe_id = ?', [row.id]);
        await writeItems(db, 'recipe_item', row.id, fileItems);
      }
      continue;
    }
    count(r, 'recipes', 'new');
    let foodId = m.nextFake--;
    const foodUid = x.food_uid && !m.takenUids.has(x.food_uid) ? x.food_uid : null;
    if (r.write) {
      foodId = (await db.run("INSERT INTO food (uid, code, source, found, data, fetched_at, created_by, drink, piece_label, piece_grams) VALUES (?, NULL, 'recipe', 1, ?, ?, ?, ?, ?, ?)",
        [foodUid, toJson(data), updated, user.id, x.drink == null ? null : flag(x.drink), x.piece_label ?? null, x.piece_grams ?? null])).lastId;
      const recipeUid = x.uid && !takenRecipeUids.has(x.uid) ? x.uid : null;
      const recipeId = (await db.run('INSERT INTO recipe (uid, food_id, portions, total_weight, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [recipeUid, foodId, x.portions, x.total_weight ?? null, user.id, updated])).lastId;
      await writeItems(db, 'recipe_item', recipeId, fileItems);
    }
    if (foodUid) m.takenUids.add(foodUid);
    if (x.food_uid) m.byUid.set(x.food_uid, foodId);
    m.source.set(foodId, 'recipe');
  }
}

/** Recipe groups: by Cookidoo link, name (case-insensitive), uid. A group is never emptied: members the file names are added. */
async function importGroups(r: Run, m: Foods): Promise<void> {
  const { db, f, user } = r;
  const groups = await db.all('SELECT id, uid, name, position, source, created_by FROM recipe_group');
  const members = new Map<number, Set<number>>();
  for (const row of await db.all('SELECT group_id, food_id FROM recipe_group_item')) {
    if (!members.has(row.group_id)) members.set(row.group_id, new Set());
    members.get(row.group_id)!.add(row.food_id);
  }
  const bySource = new Map(groups.filter((g) => g.source).map((g) => [g.source as string, g]));
  const dismissed = new Set((await db.all('SELECT source FROM recipe_group_dismissed')).map((d) => d.source as string));
  const byName = new Map(groups.map((g) => [asciiLower(g.name), g]));
  const byUid = new Map(groups.filter((g) => g.uid).map((g) => [g.uid as string, g]));
  let position = Math.max(0, ...groups.map((g) => g.position as number));
  let total = groups.length;
  for (const g of f.recipe_groups) {
    const wanted: number[] = [];
    for (const u of g.members) {
      const id = m.byUid.get(u);
      if (id !== undefined && recipeSources.has(m.source.get(id) ?? '')) wanted.push(id);
      else warn(r, 'group_members_unknown');
    }
    // the collection binding (`source`) is the household's: a guest's group has none, and a collection the household took away stays so
    const source = user.household && g.source && !dismissed.has(g.source) ? g.source : null;
    const row = (source ? bySource.get(source) : undefined) ?? byName.get(asciiLower(g.name)) ?? byUid.get(g.uid);
    if (row) {
      const have = members.get(row.id) ?? new Set();
      const missing = wanted.filter((id) => !have.has(id));
      // a shared group keeps its name: it has no time of change, so which name is newer cannot be told (members are only added)
      if (!missing.length) {
        if (row.name !== g.name) skip(r, 'recipe_groups', 'name_kept');
        else count(r, 'recipe_groups', 'unchanged');
        continue;
      }
      if (!canEdit(user, row.created_by)) { skip(r, 'recipe_groups', 'not_editable'); continue; }
      count(r, 'recipe_groups', 'changed');
      if (r.write) {
        for (const id of missing) await db.run('INSERT OR IGNORE INTO recipe_group_item (group_id, food_id) VALUES (?, ?)', [row.id, id]);
      }
      continue;
    }
    if (total >= MAX_GROUPS) { skip(r, 'recipe_groups', 'too_many_groups'); continue; }
    count(r, 'recipe_groups', 'new');
    total++;
    position++;
    if (r.write) {
      const id = (await db.run('INSERT INTO recipe_group (uid, name, position, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [byUid.has(g.uid) ? null : g.uid, g.name, position, source, user.id, past(g.created_at) ?? r.now])).lastId;
      for (const foodId of new Set(wanted)) await db.run('INSERT OR IGNORE INTO recipe_group_item (group_id, food_id) VALUES (?, ?)', [id, foodId]);
    }
    byName.set(asciiLower(g.name), { name: g.name });
  }
}

// --- per-user rows ------------------------------------------------------------------------------------------------------------------

/** Rows keyed by uid, then by external id (diary entries, workouts). Each local row is claimed by at most one file row. */
function matcher(rows: Row[]) {
  const byUid = new Map(rows.filter((x) => x.uid).map((x) => [x.uid as string, x]));
  const byExt = new Map(rows.filter((x) => x.external_id).map((x) => [x.external_id as string, x]));
  const claimed = new Set<number>();
  const find = (u?: string, ext?: string | null): Row | 'taken' | undefined => {
    const row = (u ? byUid.get(u) : undefined) ?? (ext ? byExt.get(ext) : undefined);
    if (!row) return undefined;
    if (claimed.has(row.id)) return 'taken';
    claimed.add(row.id);
    return row;
  };
  /** Whether `row` may take the external id `ext` (UNIQUE per user): no other row here has it. Records the move when it may. */
  const takeExt = (row: Row, ext: string | null): boolean => {
    if (!ext || ext === row.external_id) return true;
    const owner = byExt.get(ext);
    if (owner && owner.id !== row.id) return false;
    if (row.external_id) byExt.delete(row.external_id);
    byExt.set(ext, row);
    return true;
  };
  return Object.assign(find, { takeExt });
}

async function importDiary(r: Run, m: Foods): Promise<void> {
  const { db, f, user } = r;
  const rows = r.mode === 'replace' ? [] : await db.all('SELECT id, uid, external_id, day, meal, food_id, amount, unit, name, brand, per_100, extra, created_at, demo FROM diary_entry WHERE user_id = ?', [user.id]);
  const find = matcher(rows);
  const fresh: unknown[][] = [];
  for (const e of f.diary) {
    const created = past(e.logged_at);
    const want = { day: e.day, meal: e.meal, amount: e.amount, unit: e.unit, name: e.name, brand: e.brand ?? null, per_100: e.per_100, extra: e.extra_per_100 ?? {} };
    const linked = Boolean(e.food_uid || e.food_code);
    const foodId = resolve(m, e.food_uid, e.food_code);
    if (linked && foodId === null) warn(r, 'links_unknown');
    const row = find(e.uid, e.external_id);
    if (row === 'taken') { skip(r, 'diary', 'duplicate'); continue; }
    if (row) {
      if (row.demo) { skip(r, 'diary', 'demo'); continue; } // sample data here is never overwritten
      const have = { day: row.day, meal: row.meal, amount: row.amount, unit: row.unit, name: row.name, brand: row.brand, per_100: per100View(JSON.parse(row.per_100)), extra: nutrients.clean(parseJson(row.extra)) };
      const ext = e.external_id === undefined ? row.external_id : e.external_id;
      // the file's link wins, also "no link"; a link to a product that is neither here nor in the file leaves the link here alone
      const link = !linked ? null : foodId ?? row.food_id;
      if (same(have, want) && (created ?? row.created_at) === row.created_at && ext === row.external_id && link === row.food_id) { count(r, 'diary', 'unchanged'); continue; }
      if (!find.takeExt(row, ext)) { skip(r, 'diary', 'external_id_taken'); continue; }
      count(r, 'diary', 'changed');
      if (r.write) {
        await db.run('UPDATE diary_entry SET day = ?, meal = ?, amount = ?, unit = ?, name = ?, brand = ?, per_100 = ?, extra = ?, created_at = ?, external_id = ?, '
          + 'food_id = ?, demo = 0, import_id = NULL WHERE id = ?',
        [want.day, want.meal, want.amount, want.unit, want.name, want.brand, toJson(want.per_100), toJson(want.extra), created ?? row.created_at, ext ?? null, link, row.id]);
      }
      continue;
    }
    count(r, 'diary', 'new');
    fresh.push([user.id, e.uid ?? null, want.day, want.meal, foodId !== null && foodId > 0 ? foodId : null, want.amount, want.unit, want.name, want.brand, toJson(want.per_100), toJson(want.extra), created ?? r.now, e.external_id ?? null]);
  }
  if (r.write) await insertMany(db, 'diary_entry', ['user_id', 'uid', 'day', 'meal', 'food_id', 'amount', 'unit', 'name', 'brand', 'per_100', 'extra', 'created_at', 'external_id'], fresh);
}

async function importTemplates(r: Run, m: Foods): Promise<void> {
  const { db, f, user } = r;
  const rows = r.mode === 'replace' ? [] : await db.all('SELECT id, uid, name, created_at FROM template WHERE user_id = ?', [user.id]);
  const items = new Map<number, Row[]>();
  if (rows.length) {
    for (const it of await db.all('SELECT i.* FROM template_item i JOIN template t ON t.id = i.template_id WHERE t.user_id = ? ORDER BY i.id', [user.id])) {
      items.set(it.template_id, [...(items.get(it.template_id) ?? []), it]);
    }
  }
  const find = matcher(rows);
  for (const t of f.templates) {
    const fileItems: [FileItem, number | null][] = t.items.map((i) => [i, itemFood(r, m, i, false)]);
    const created = past(t.created_at);
    const row = find(t.uid);
    if (row === 'taken') { skip(r, 'templates', 'duplicate'); continue; }
    if (row) {
      const have = { name: row.name, items: (items.get(row.id) ?? []).map(localItem) };
      if (same(have, { name: t.name, items: t.items.map(itemView) }) && (created ?? row.created_at) === row.created_at) { count(r, 'templates', 'unchanged'); continue; }
      count(r, 'templates', 'changed');
      if (r.write) {
        await db.run('UPDATE template SET name = ?, created_at = ? WHERE id = ?', [t.name, created ?? row.created_at, row.id]);
        await db.run('DELETE FROM template_item WHERE template_id = ?', [row.id]);
        await writeItems(db, 'template_item', row.id, fileItems.map(([i, id]) => [i, id !== null && id > 0 ? id : null]));
      }
      continue;
    }
    count(r, 'templates', 'new');
    if (r.write) {
      const id = (await db.run('INSERT INTO template (uid, user_id, name, created_at) VALUES (?, ?, ?, ?)', [t.uid ?? null, user.id, t.name, created ?? r.now])).lastId;
      await writeItems(db, 'template_item', id, fileItems.map(([i, fid]) => [i, fid !== null && fid > 0 ? fid : null]));
    }
  }
}

/** Weight, water, activity, sleep: one row per day; the file's values win. */
async function importDays(r: Run, kind: 'weight' | 'water' | 'activity' | 'sleep', table: string, cols: string[], rows: Record<string, unknown>[]): Promise<void> {
  const { db, user } = r;
  const local = r.mode === 'replace' ? [] : await db.all(`SELECT day, demo, ${cols.join(', ')} FROM ${table} WHERE user_id = ?`, [user.id]);
  const byDay = new Map(local.map((x) => [x.day as string, x]));
  const fresh: unknown[][] = [];
  for (const row of rows) {
    const want = cols.map((c) => row[c] ?? null);
    if (row.source === 'demo') { skip(r, kind, 'demo'); continue; } // sample values of the file make no real rows
    const have = byDay.get(row.day as string);
    if (have) {
      if (have.demo) { skip(r, kind, 'demo'); continue; } // sample data here is never overwritten
      if (same(cols.map((c) => have[c]), want)) { count(r, kind, 'unchanged'); continue; }
      count(r, kind, 'changed');
      const importCol = table === 'sleep_day' ? '' : ', import_id = NULL';
      if (r.write) await db.run(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')}${importCol} WHERE user_id = ? AND day = ?`, [...(want as any[]), user.id, row.day as string]);
      continue;
    }
    count(r, kind, 'new');
    fresh.push([user.id, row.day, ...want]);
  }
  if (r.write) await insertMany(db, table, ['user_id', 'day', ...cols], fresh);
}

async function importWorkouts(r: Run): Promise<void> {
  const { db, f, user } = r;
  const cols = ['day', 'started_at', 'kind', 'name', 'minutes', 'kcal', 'distance_m', 'steps', 'note', 'source'];
  const rows = r.mode === 'replace' ? [] : await db.all(`SELECT id, uid, external_id, demo, created_at, ${cols.join(', ')} FROM workout WHERE user_id = ?`, [user.id]);
  const find = matcher(rows);
  const fresh: unknown[][] = [];
  for (const w of f.workouts) {
    const want = [w.day, seconds(w.started_at), w.kind, w.name, w.minutes, w.kcal ?? null, w.distance_m ?? null, w.steps ?? null, w.note ?? null, w.source];
    if (w.source === 'demo') { skip(r, 'workouts', 'demo'); continue; } // sample workouts of the file make no real rows
    const row = find(w.uid, w.external_id);
    if (row === 'taken') { skip(r, 'workouts', 'duplicate'); continue; }
    if (row) {
      if (row.demo) { skip(r, 'workouts', 'demo'); continue; }
      const ext = w.external_id === undefined ? row.external_id : w.external_id;
      if (same(cols.map((c) => row[c]), want) && ext === row.external_id) { count(r, 'workouts', 'unchanged'); continue; }
      if (!find.takeExt(row, ext ?? null)) { skip(r, 'workouts', 'external_id_taken'); continue; }
      count(r, 'workouts', 'changed');
      if (r.write) await db.run(`UPDATE workout SET ${cols.map((c) => `${c} = ?`).join(', ')}, external_id = ?, import_id = NULL WHERE id = ?`, [...(want as any[]), ext ?? null, row.id]);
      continue;
    }
    count(r, 'workouts', 'new');
    fresh.push([user.id, w.uid ?? null, w.external_id ?? null, r.now, ...want]);
  }
  if (r.write) await insertMany(db, 'workout', ['user_id', 'uid', 'external_id', 'created_at', ...cols], fresh);
}

/** Fasts by uid. At most one fast of a person runs: a running fast of the file is skipped while another one runs here. */
async function importFasts(r: Run): Promise<void> {
  const { db, f, user } = r;
  const rows = r.mode === 'replace' ? [] : await db.all('SELECT id, uid, started_at, ended_at, target_hours FROM fast WHERE user_id = ?', [user.id]);
  const find = matcher(rows);
  let running = rows.find((x) => x.ended_at === null)?.id ?? null;
  const plan: [typeof f.fasting[number], Row | undefined][] = [];
  for (const x of f.fasting) {
    const row = find(x.uid);
    if (row === 'taken') { skip(r, 'fasting', 'duplicate'); continue; }
    plan.push([x, row]);
    if (row && row.id === running && x.ended_at) running = null; // the file ends the fast that runs here
  }
  // updates first, and among them those that end a fast before those that open one: the fast that runs here ends before another
  // starts (UNIQUE fast_open), then new fasts
  const updates = plan.filter(([, row]) => row).sort(([a], [b]) => Number(!a.ended_at) - Number(!b.ended_at));
  for (const [x, row] of updates) {
    if (!row) continue;
    const want = [seconds(x.started_at), seconds(x.ended_at), x.target_hours];
    if (same([row.started_at, row.ended_at, row.target_hours], want)) { count(r, 'fasting', 'unchanged'); continue; }
    if (!x.ended_at && running !== null && running !== row.id) { skip(r, 'fasting', 'running_fast'); continue; }
    count(r, 'fasting', 'changed');
    if (!x.ended_at) running = row.id;
    if (r.write) await db.run('UPDATE fast SET started_at = ?, ended_at = ?, target_hours = ? WHERE id = ?', [...want, row.id]);
  }
  for (const [x, row] of plan) {
    if (row) continue;
    if (!x.ended_at && running !== null) { skip(r, 'fasting', 'running_fast'); continue; }
    count(r, 'fasting', 'new');
    if (!x.ended_at) running = -1;
    if (r.write) await db.run('INSERT INTO fast (uid, user_id, started_at, ended_at, target_hours) VALUES (?, ?, ?, ?, ?)', [x.uid ?? null, user.id, seconds(x.started_at), seconds(x.ended_at), x.target_hours]);
  }
}

const GOAL_KEYS = ['kcal', 'protein', 'carbs', 'fat', 'water_ml', 'steps'] as const;
/** A goal with its weekday schedule (`alt`, null when off) in one comparable shape; `source` is a database row or a goal of the file
 * (files without `days_goal`, e.g. from before weekday goals, read as off). */
const goalWith = (source: Row | { days_goal?: Parameters<typeof scheduleFrom>[0] }, fromFile: boolean) => ({
  ...goalOf(source as Row), alt: fromFile ? scheduleFrom((source as { days_goal?: Parameters<typeof scheduleFrom>[0] }).days_goal) : scheduleOf(source as Row),
});
type GoalWith = ReturnType<typeof goalWith>;
const goalKeys = (g: GoalWith): Record<string, unknown> => ({ ...Object.fromEntries(GOAL_KEYS.map((k) => [k, g[k]])), alt: g.alt });
const altParams = (g: GoalWith) => [g.alt?.days ?? 0, g.alt?.kcal ?? null, g.alt?.protein ?? null, g.alt?.carbs ?? null, g.alt?.fat ?? null];
const HISTORY_SQL = 'INSERT INTO goal_history (user_id, valid_from, kcal, protein, carbs, fat, water_ml, steps, changed_at, alt_days, alt_kcal, alt_protein, alt_carbs, alt_fat) '
  + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
  + 'ON CONFLICT(user_id, valid_from) DO UPDATE SET kcal = excluded.kcal, protein = excluded.protein, carbs = excluded.carbs, fat = excluded.fat, '
  + 'water_ml = excluded.water_ml, steps = excluded.steps, changed_at = excluded.changed_at, alt_days = excluded.alt_days, alt_kcal = excluded.alt_kcal, '
  + 'alt_protein = excluded.alt_protein, alt_carbs = excluded.alt_carbs, alt_fat = excluded.alt_fat';

/** The goal history by `valid_from` (the file wins on the same day, rows only here stay). The goal is the file's: when a change here is
 * newer than the file's newest, the file's goal is recorded as a change from today on, which keeps "the newest history row is the goal".
 * The weekday goal travels with each goal (a file from before it has none: the goal it brings is the one without a schedule). */
async function importGoal(r: Run): Promise<void> {
  const { db, f, user } = r;
  const hist = r.mode === 'replace' ? [] : await db.all('SELECT * FROM goal_history WHERE user_id = ?', [user.id]);
  const local = r.mode === 'replace' ? undefined : await db.get('SELECT * FROM goal WHERE user_id = ?', [user.id]);
  const merged = new Map(hist.map((h) => [h.valid_from as string, { ...goalWith(h, false), changed_at: h.changed_at as number | null }]));
  const rows = f.goal_history.length || !f.goal ? f.goal_history : [{ valid_from: SINCE_START, ...f.goal, changed_at: null }];
  for (const h of rows) {
    const want = { ...goalWith(h, true), changed_at: past(h.changed_at) };
    const have = merged.get(h.valid_from);
    merged.set(h.valid_from, want);
    if (have && same(have, want)) { count(r, 'goal_history', 'unchanged'); continue; }
    count(r, 'goal_history', have ? 'changed' : 'new');
    if (r.write) await db.run(HISTORY_SQL, [user.id, h.valid_from, ...GOAL_KEYS.map((k) => want[k]), want.changed_at, ...altParams(want)]);
  }
  if (!rows.length) return;
  let newest = merged.get([...merged.keys()].sort().at(-1)!)!;
  if (f.goal && !same(goalKeys(newest), goalKeys(goalWith(f.goal, true)))) {
    // a later change here than in the file: the file's goal still wins, as a change from today on (like PUT /me/goal), so that earlier
    // days keep their goal and the newest history row stays the goal
    const day = today();
    const want = { ...goalWith(f.goal, true), changed_at: r.now };
    count(r, 'goal_history', merged.has(day) ? 'changed' : 'new');
    for (const later of [...merged.keys()].filter((k) => k > day)) merged.delete(later); // like PUT /me/goal: a later row would win again
    if (r.write) await db.run('DELETE FROM goal_history WHERE user_id = ? AND valid_from > ?', [user.id, day]);
    merged.set(day, want);
    newest = want;
    warn(r, 'goal_from_today');
    if (r.write) await db.run(HISTORY_SQL, [user.id, day, ...GOAL_KEYS.map((k) => want[k]), want.changed_at, ...altParams(want)]);
  }
  const goal = goalKeys(newest);
  if (local && same(goalKeys(goalWith(local, false)), goal)) { count(r, 'goal', 'unchanged'); return; }
  count(r, 'goal', local ? 'changed' : 'new');
  if (r.write) {
    await db.run('INSERT INTO goal (user_id, kcal, protein, carbs, fat, water_ml, steps, alt_days, alt_kcal, alt_protein, alt_carbs, alt_fat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET '
      + 'kcal = excluded.kcal, protein = excluded.protein, carbs = excluded.carbs, fat = excluded.fat, water_ml = excluded.water_ml, steps = excluded.steps, '
      + 'alt_days = excluded.alt_days, alt_kcal = excluded.alt_kcal, alt_protein = excluded.alt_protein, alt_carbs = excluded.alt_carbs, alt_fat = excluded.alt_fat, import_id = NULL',
    [user.id, ...GOAL_KEYS.map((k) => goal[k] as number), ...altParams(newest)]);
  }
}

/** The settings of the settings page (checked like PATCH /me/settings); anything else in the file (the display name, internal marks) is not taken. */
async function importSettings(r: Run): Promise<void> {
  const { db, f, user } = r;
  const local = new Map((r.mode === 'replace' ? [] : await db.all('SELECT key, value FROM user_setting WHERE user_id = ?', [user.id])).map((x) => [x.key as string, JSON.parse(x.value)]));
  for (const [key, raw] of Object.entries(f.settings ?? {})) {
    if (!SETTING_KEYS.includes(key)) { skip(r, 'settings', 'not_a_setting'); continue; }
    const schema = (SETTINGS.shape as Record<string, z.ZodType>)[key]!;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) { skip(r, 'settings', 'invalid'); continue; }
    // the stored value read the way the settings page reads it (defaults of a partial object, glass sizes sorted): an own export
    // imported again changes nothing
    const here = local.has(key) ? schema.safeParse(local.get(key)) : null;
    if (here?.success && same(here.data, parsed.data)) { count(r, 'settings', 'unchanged'); continue; }
    count(r, 'settings', local.has(key) ? 'changed' : 'new');
    if (r.write) {
      await db.run('INSERT INTO user_setting (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value', [user.id, key, toJson(parsed.data ?? null)]);
    }
  }
}

async function importBadges(r: Run): Promise<void> {
  const { db, f, user } = r;
  const have = new Set((r.mode === 'replace' ? [] : await db.all('SELECT code FROM badge_earned WHERE user_id = ?', [user.id])).map((x) => x.code as string));
  for (const b of f.badges) {
    if (!(BADGE_CODES as readonly string[]).includes(b.code)) { skip(r, 'badges', 'unknown'); continue; }
    if (have.has(b.code)) { count(r, 'badges', 'unchanged'); continue; }
    count(r, 'badges', 'new');
    if (r.write) await db.run('INSERT INTO badge_earned (user_id, code, earned_at, seen, demo) VALUES (?, ?, ?, 1, 0)', [user.id, b.code, past(b.earned_at) ?? r.now]);
  }
}

// --- the whole run ------------------------------------------------------------------------------------------------------------------

export interface ImportResult { counts: Counts; warnings: Record<string, number>; deleted: Record<string, number> | null }

/** Preview (`write` false: reads only) or import (`write` true: call inside ONE transaction and pass its handle). */
export async function runImport(db: Db, user: User, f: ExportFile, mode: Mode, write: boolean, now: number): Promise<ImportResult> {
  const r: Run = { db, user, f, mode, write, counts: emptyCounts(), warnings: {}, now: Math.floor(now) };
  let deleted: Record<string, number> | null = null;
  if (mode === 'replace') {
    deleted = await ownCounts(db, user.id);
    if (write) await deleteOwn(db, user.id);
  }
  const m = await importFoods(r);
  await importRecipes(r, m);
  await importGroups(r, m);
  await importDiary(r, m);
  await importTemplates(r, m);
  await importDays(r, 'weight', 'weight', ['kg', 'body_fat_pct', 'lean_kg', 'health', 'body_fat_health', 'lean_health'],
    f.weight.map((w) => ({ ...w, body_fat_pct: w.body_fat_pct ?? null, lean_kg: w.lean_kg ?? null, health: flag(w.health), body_fat_health: flag(w.body_fat_health), lean_health: flag(w.lean_health) })));
  await importDays(r, 'water', 'water', ['ml', 'health'], f.water.map((w) => ({ ...w, health: flag(w.health) })));
  await importDays(r, 'activity', 'activity_day', ['steps', 'active_kcal', 'distance_m', 'source'], f.activity);
  await importDays(r, 'sleep', 'sleep_day', ['minutes', 'source'], f.sleep);
  await importWorkouts(r);
  await importFasts(r);
  await importGoal(r);
  await importSettings(r);
  await importBadges(r);
  for (let i = 0; i < f.webhooks.length; i++) skip(r, 'webhooks', 'not_imported'); // their secret is not in the file
  if (f.webhooks.length) warn(r, 'webhooks_not_imported', f.webhooks.length);
  return { counts: r.counts, warnings: r.warnings, deleted };
}

// --- the waiting file -----------------------------------------------------------------------------------------------------------------

interface Staged { json: Uint8Array; token: string; expires: number }

/** What a person uploaded, between preview and confirm: the JSON bytes (not parsed: smaller), a token that the confirmation must name,
 * gone after 20 minutes without use, after the import, on "discard" and when the session ends. */
export class ImportStage {
  private items = new Map<number, Staged>();
  private busy = new Set<number>();
  private clock: () => number;
  constructor(clock: () => number) { this.clock = clock; }

  /** How many areas are held (without expiring any). */
  held(): number { return this.items.size; }

  /** Drop the areas whose time is up (cheap: called before every request, see dispatch.ts). */
  sweep(): void { this.expire(); }

  private expire(): void {
    const now = this.clock();
    for (const [u, s] of this.items) if (s.expires < now && !this.busy.has(u)) this.items.delete(u);
  }

  get(userId: number): Staged | undefined { this.expire(); return this.items.get(userId); }

  put(userId: number, json: Uint8Array): Staged {
    this.expire();
    let others = 0;
    for (const [u, s] of this.items) if (u !== userId) others += s.json.length;
    if (others + json.length > MAX_STAGED) throw new StageError('busy', 'the server holds too many uploads at the moment; try again in a few minutes');
    const s = { json, token: tokenUrlsafe(12), expires: this.clock() + TTL };
    this.items.set(userId, s);
    return s;
  }

  clear(userId: number, token?: string): void {
    const s = this.items.get(userId);
    if (s && (token === undefined || s.token === token)) this.items.delete(userId);
  }

  begin(userId: number): boolean {
    if (this.busy.has(userId)) return false;
    this.busy.add(userId);
    return true;
  }

  end(userId: number): void {
    this.busy.delete(userId);
    const s = this.items.get(userId);
    if (s) s.expires = this.clock() + TTL;
  }
}
