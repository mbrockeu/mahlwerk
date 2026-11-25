// Personal data export (export.py): everything one user holds, as a ZIP of CSV files (for Excel and Numbers) and one complete
// JSON file. There is deliberately no export of the whole database: every function takes ONE user and reads only rows of that
// user (store/export.ts, which names its columns). Passwords, sessions, access keys, webhook secrets, stored secrets and the
// identity at a sign-in provider are not part of any table read here.
import { isoLocal } from './calendar.ts';
import type { Db } from './db.ts';
import * as nutrients from './nutrients.ts';
import { PER_100_KEYS, scale } from './nutrition.ts';
import { roundHalfEven } from './num.ts';
import { exportAccount, exportActivity, exportBadges, exportDiary, exportFasts, exportFoods, exportRecipeGroups, exportRecipes, exportSleep, exportTemplates, exportWater, exportWebhooks, exportWeights, exportWorkouts } from './store/export.ts';
import { goalHistory, getGoal } from './store/goals.ts';
import { getSettings } from './store/settings.ts';
import { VERSION } from './version.ts';
import { buildZip } from './zip.ts';

export const FORMAT_VERSION = 2;
const FIRST_DAY = '0000-01-01', LAST_DAY = '9999-12-31'; // an open end of the range

// CSV columns: [key, English header, German header]
type Columns = readonly (readonly [string, string, string])[];
const DIARY_COLUMNS: Columns = [
  ['day', 'Day', 'Tag'], ['meal', 'Meal', 'Mahlzeit'], ['name', 'Name', 'Name'], ['brand', 'Brand', 'Marke'],
  ['amount', 'Amount', 'Menge'], ['unit', 'Unit', 'Einheit'],
  ['kcal', 'Energy (kcal)', 'Energie (kcal)'], ['protein', 'Protein (g)', 'Eiweiß (g)'],
  ['carbs', 'Carbohydrates (g)', 'Kohlenhydrate (g)'], ['fat', 'Fat (g)', 'Fett (g)'],
  ['saturated_fat', 'Saturated fat (g)', 'Gesättigte Fettsäuren (g)'], ['sugars', 'Sugars (g)', 'Zucker (g)'],
  ['fiber', 'Fiber (g)', 'Ballaststoffe (g)'], ['salt', 'Salt (g)', 'Salz (g)'],
];
const WEIGHT_COLUMNS: Columns = [
  ['day', 'Day', 'Tag'], ['kg', 'Weight (kg)', 'Gewicht (kg)'], ['body_fat_pct', 'Body fat (%)', 'Körperfett (%)'],
  ['lean_kg', 'Lean body mass (kg)', 'Magermasse (kg)'],
];
const ACTIVITY_COLUMNS: Columns = [
  ['day', 'Day', 'Tag'], ['steps', 'Steps', 'Schritte'], ['active_kcal', 'Active energy (kcal)', 'Aktive Energie (kcal)'],
  ['distance_m', 'Distance (m)', 'Strecke (m)'], ['source', 'Source', 'Quelle'],
];
const WORKOUT_COLUMNS: Columns = [
  ['day', 'Day', 'Tag'], ['started_at', 'Started', 'Beginn'], ['kind', 'Type', 'Art'], ['name', 'Name', 'Name'],
  ['minutes', 'Minutes', 'Minuten'], ['kcal', 'Energy (kcal)', 'Energie (kcal)'], ['distance_m', 'Distance (m)', 'Strecke (m)'],
  ['steps', 'Steps', 'Schritte'], ['note', 'Note', 'Notiz'], ['source', 'Source', 'Quelle'],
];
const WATER_COLUMNS: Columns = [['day', 'Day', 'Tag'], ['ml', 'Water (ml)', 'Wasser (ml)']];
const FASTING_COLUMNS: Columns = [
  ['started_at', 'Started', 'Beginn'], ['ended_at', 'Ended', 'Ende'], ['target_hours', 'Target (hours)', 'Ziel (Stunden)'],
  ['hours', 'Actual (hours)', 'Tatsächlich (Stunden)'],
];

type Json = Record<string, any>;
const round = (value: number | null, digits = 2): number | null => (value === null ? null : roundHalfEven(value, digits));
const withDates = (rows: Json[], ...keys: string[]): Json[] => rows.map((r) => ({ ...r, ...Object.fromEntries(keys.filter((k) => k in r).map((k) => [k, isoLocal(r[k])])) }));

/** One row per entry with the nutrients for its amount (the core values and the other stored ones) next to the values per 100 g/ml. */
async function diary(db: Db, userId: number, first: string, last: string, demo: boolean): Promise<Json[]> {
  return (await exportDiary(db, userId, first, last, demo)).map((e) => {
    const values = scale(e.per_100, e.amount);
    const extra = nutrients.clean(e.extra);
    return {
      uid: e.uid, day: e.day, meal: e.meal, name: e.name, brand: e.brand, amount: e.amount, unit: e.unit, logged_at: isoLocal(e.created_at),
      per_100: e.per_100, extra_per_100: extra,
      nutrients: {
        ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, round(v)])),
        ...Object.fromEntries(Object.entries(nutrients.scaleExtra(extra, e.amount)).map(([k, v]) => [k, round(v, 3)])),
      },
      external_id: e.external_id, food_uid: e.food_uid, food_code: e.food_code,
    };
  });
}

/** Name, events, switch and the host of the address; path and query of an address can carry a secret (a hook id), so they stay out. */
async function webhooks(db: Db, userId: number): Promise<Json[]> {
  return (await exportWebhooks(db, userId)).map((h) => {
    let host: string | null = null;
    try { host = new URL(h.url).hostname.replace(/^\[|\]$/g, '') || null; } catch { /* no host */ }
    return { name: h.name, host, events: h.events, enabled: h.enabled, created_at: isoLocal(h.created_at) };
  });
}

// CSV ------------------------------------------------------------------------------------------------------------------

/** German spreadsheets want `;` and a decimal comma, English ones `,` and a point. */
class CsvStyle {
  lang: string;
  delimiter: string;
  constructor(lang: string) {
    this.lang = lang;
    this.delimiter = lang === 'de' ? ';' : ',';
  }

  cell(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'number') {
      let text = roundHalfEven(value, 6).toFixed(6);
      if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
      text = text === '' || text === '-0' ? '0' : text; // no exponent, no trailing zeros
      return this.lang === 'de' ? text.replace('.', ',') : text;
    }
    const text = String(value);
    // a text a spreadsheet would run as a formula gets a leading apostrophe (names come from products and imports)
    return '=+-@\t\r'.includes(text.slice(0, 1)) && text !== '' ? `'${text}` : text;
  }

  private quote(field: string): string {
    return /["\r\n]/.test(field) || field.includes(this.delimiter) ? `"${field.replaceAll('"', '""')}"` : field;
  }

  /** UTF-8 with a BOM, so that Excel does not read it as Windows-1252; lines end with CRLF. */
  render(columns: Columns, rows: Json[]): Uint8Array {
    const lines = [columns.map(([, en, de]) => (this.lang === 'de' ? de : en)), ...rows.map((row) => columns.map(([key]) => this.cell(row[key])))];
    const text = lines.map((cells) => cells.map((c) => this.quote(c)).join(this.delimiter) + '\r\n').join('');
    return new TextEncoder().encode('﻿' + text);
  }
}

/** The fixed columns plus one for every other nutrient at least one entry has a value for (in the order of the directory). */
function diaryColumns(rows: Json[]): Columns {
  const used = new Set(rows.flatMap((r) => Object.keys(r.nutrients)).filter((k) => !(PER_100_KEYS as readonly string[]).includes(k)));
  const units = new Map(nutrients.NUTRIENTS.map((n) => [n.key, n.unit]));
  const label = (key: string) => { const t = key.replaceAll('_', ' '); return `${t.charAt(0).toUpperCase()}${t.slice(1).toLowerCase()} (${units.get(key)})`; };
  return [...DIARY_COLUMNS, ...nutrients.KEYS.filter((k) => used.has(k)).map((k): [string, string, string] => [k, label(k), label(k)])];
}

const MEAL_NAMES_DE: Record<string, string> = { breakfast: 'Frühstück', lunch: 'Mittagessen', dinner: 'Abendessen', snack: 'Snacks' };

/** The CSV names the meal in the reader's language; the JSON keeps the stored key. */
const diaryRows = (rows: Json[], lang: string): Json[] => rows.map((r) => ({ ...r, ...r.nutrients, meal: lang === 'de' ? (MEAL_NAMES_DE[r.meal] ?? r.meal) : r.meal }));

const jsonText = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value, (_k, v) => {
  if (typeof v === 'number' && !Number.isFinite(v)) throw new RangeError('NaN or infinity cannot be exported');
  return v;
}));

// the archive ------------------------------------------------------------------------------------------------------------

/** The whole archive in memory. `first`/`last` limit the day-based data; the demo rows of an own account are left out, the
 * demo account itself exports its sample data. */
export async function buildExport(db: Db, user: { id: number; username: string; display_name: string; is_demo?: unknown; household?: unknown }, first: string | null, last: string | null, lang: string, nowSeconds: number): Promise<Uint8Array> {
  const demo = Boolean(user.is_demo);
  const a = first || FIRST_DAY, b = last || LAST_DAY, uid = user.id;
  const account = (await exportAccount(db, uid)) ?? {};
  const history = (await goalHistory(db, uid)).reverse().map((g) => ({ ...g, changed_at: isoLocal(g.changed_at) })); // oldest first
  const workouts = (await exportWorkouts(db, uid, a, b, demo)).map((w) => ({ ...w, started_at: isoLocal(w.started_at) }));
  const diaryData = await diary(db, uid, a, b, demo);
  const fasting = (await exportFasts(db, uid, a, b)).map((f) => ({
    uid: f.uid, started_at: isoLocal(f.started_at), ended_at: isoLocal(f.ended_at), target_hours: f.target_hours,
    hours: f.ended_at === null ? null : roundHalfEven((f.ended_at - f.started_at) / 3600, 2),
  }));
  const data: Json = {
    format_version: FORMAT_VERSION,
    exported_at: isoLocal(Math.floor(nowSeconds)),
    app_version: VERSION,
    range: { from: first, to: last },
    account: { username: user.username, display_name: user.display_name, created_at: isoLocal(account.created_at) },
    goal: await getGoal(db, uid),
    goal_history: history,
    settings: await getSettings(db, uid),
    diary: diaryData,
    weight: await exportWeights(db, uid, a, b, demo),
    activity: await exportActivity(db, uid, a, b, demo),
    sleep: await exportSleep(db, uid, a, b, demo),
    workouts,
    water: await exportWater(db, uid, a, b, demo),
    fasting,
    templates: withDates(await exportTemplates(db, uid), 'created_at'),
    recipes: withDates(await exportRecipes(db, uid, demo), 'updated_at'),
    recipe_groups: withDates(await exportRecipeGroups(db, uid), 'created_at'),
    foods: withDates(await exportFoods(db, uid, a, b, demo, Boolean(user.household) && !demo), 'fetched_at'), // the demo account: its own sample data only
    badges: withDates(await exportBadges(db, uid, demo), 'earned_at'),
    webhooks: await webhooks(db, uid),
  };
  const style = new CsvStyle(lang);
  return buildZip([
    ['diary.csv', style.render(diaryColumns(data.diary), diaryRows(data.diary, lang))],
    ['weight.csv', style.render(WEIGHT_COLUMNS, data.weight)],
    ['activity.csv', style.render(ACTIVITY_COLUMNS, data.activity)],
    ['workouts.csv', style.render(WORKOUT_COLUMNS, data.workouts)],
    ['water.csv', style.render(WATER_COLUMNS, data.water)],
    ['fasting.csv', style.render(FASTING_COLUMNS, data.fasting)],
    ['mahlwerk-export.json', jsonText(data)],
  ], new Date(nowSeconds * 1000));
}

/** `mahlwerk-export-<user>-<day>.zip`; characters that do not belong in a file name (the demo user is `~demo`) become `_`. */
export const fileName = (username: string, day: string): string => `mahlwerk-export-${username.replace(/[^A-Za-z0-9._-]/g, '_') || 'user'}-${day}.zip`;
