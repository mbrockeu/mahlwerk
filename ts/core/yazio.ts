// Import the diary of an exported Yazio account (yazio.py, without the command line): the parsed files of the exporter
// (`products.json`, `days.json`, `weight.json`) become a plan that store/imports.ts writes in one transaction. The one core
// behind the file upload and the direct sign-in. See yazio.py for how things map (product, recipe portion, quick entry, weights,
// water, activity, workouts, goal).
import * as act from './activity.ts';
import { dayToDate } from './dates.ts';
import type { Db } from './db.ts';
import { MEALS } from './models/common.ts';
import { extraFromYazio, parseNumber, YAZIO_KEYS } from './nutrients.ts';
import { PER_100_KEYS, isComplete } from './nutrition.ts';
import { pySum, roundHalfEven } from './num.ts';
import { importYazio, type Plan, type PlanEntry, type PlanFood, type PlanGoal, type PlanWorkout } from './store/imports.ts';
import { MAX_WATER_ML } from './store/water.ts';
import { pyHead, pyLen, pySplit, pyStrip } from './text.ts';

export const FILES = ['products.json', 'days.json', 'weight.json'] as const;
const CORE: Record<string, string> = {
  'energy.energy': 'kcal', 'nutrient.fat': 'fat', 'nutrient.saturated': 'saturated_fat', 'nutrient.carb': 'carbs', 'nutrient.sugar': 'sugars',
  'nutrient.dietaryfiber': 'fiber', 'nutrient.protein': 'protein', 'nutrient.salt': 'salt',
};
const MAX_KCAL_100 = 950; // as in the catalogue import
const MAX_GRAMS_100 = 100;
const MAX_AMOUNT = 50_000; // g/ml of one entry
const MAX_PORTIONS = 1_000;
const WEIGHT_RANGE = [20.0, 500.0] as const;
const GOAL_KCAL = [500, 10_000] as const;
const GOAL_GRAMS = [0, 1_000] as const;
const GOAL_WATER = [500, 6_000] as const;
const DEFAULT_WATER_GOAL = 2000;
const QUICK_PORTION = 100.0; // a quick entry is stored as 100 g with per 100 g = its absolute values

/** The period of a refresh: the days Yazio was asked for, every one of them. */
export interface Refresh { first_day: string; last_day: string }

/** The export cannot be used (wrong shape, none of the files). */
export class YazioError extends Error {}

type Counter = Map<string, number>;
const bump = (c: Counter, key: string) => c.set(key, (c.get(key) ?? 0) + 1);

export interface Summary {
  days: number;
  entries: Record<'product' | 'recipe' | 'quick', number>;
  foods_created: number; foods_reused: number;
  weights: number; weights_kept: number;
  activity_days: number; activity_kept: number;
  workouts: number; workouts_already: number;
  water: number; water_kept: number;
  goal_set: boolean; already_imported: number;
  /** Refresh mode (direct sign-in, "last N days"), see yazio.py. */
  refresh: Refresh | null; entries_seen: number; workouts_seen: number;
  entries_updated: number; entries_removed: number; workouts_updated: number; workouts_removed: number;
  weights_updated: number; water_updated: number; activity_updated: number;
  skipped: Counter; notes: Counter; unknown_keys: Counter;
  dropped_values: number; missing_files: string[];
  batch_id: number | null; dry_run: boolean;
  total_entries: number;
}

const newSummary = (dryRun: boolean): Summary => ({
  days: 0, entries: { product: 0, recipe: 0, quick: 0 }, foods_created: 0, foods_reused: 0, weights: 0, weights_kept: 0, activity_days: 0,
  activity_kept: 0, workouts: 0, workouts_already: 0, water: 0, water_kept: 0, goal_set: false, already_imported: 0, refresh: null, entries_seen: 0,
  workouts_seen: 0, entries_updated: 0, entries_removed: 0, workouts_updated: 0, workouts_removed: 0, weights_updated: 0, water_updated: 0,
  activity_updated: 0, skipped: new Map(),
  notes: new Map(), unknown_keys: new Map(), dropped_values: 0, missing_files: [], batch_id: null, dry_run: dryRun, total_entries: 0,
});

// Python truthiness and isinstance, for values that come from a JSON file.
const truthy = (v: unknown): boolean => !(v === null || v === undefined || v === false || v === 0 || v === '' || (Array.isArray(v) && !v.length)
  || (typeof v === 'object' && v !== null && !Array.isArray(v) && !Object.keys(v).length));
const isDict = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const get = (o: Record<string, any>, k: string): any => (Object.hasOwn(o, k) ? o[k] : undefined); // never the prototype's
const text = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? 'None' : String(v)); // str(value)

function isDay(value: unknown): value is string {
  return typeof value === 'string' && dayToDate(value) !== null;
}

/** The first 200 characters of the text with blanks collapsed, null when empty or no text. */
function clean(value: unknown, limit = 200): string | null {
  return typeof value === 'string' ? pyHead(pySplit(value).join(' '), limit) || null : null;
}

/** Python's format(x, 'g') for the amounts of a portion (at most 5000, above 0). */
function formatG(x: number): string {
  if (Math.abs(x) < 1e-4) {
    const [mantissa, exp] = x.toExponential(5).split('e');
    const m = mantissa!.includes('.') ? mantissa!.replace(/0+$/, '').replace(/\.$/, '') : mantissa!;
    return `${m}e${exp![0]}${exp!.slice(1).padStart(2, '0')}`;
  }
  const exp = Math.floor(Math.log10(Math.abs(x)));
  const rounded = roundHalfEven(x, 5 - exp);
  const digits = Math.max(0, 5 - Math.floor(Math.log10(Math.abs(rounded))));
  const fixed = rounded.toFixed(digits);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/** Turns Yazio nutrient objects into the per-100 values and extra nutrients of a snapshot. */
class Convert {
  summary: Summary;
  constructor(summary: Summary) { this.summary = summary; }

  /** `values` x `factor` = per 100 g/ml. `strict` checks the limits of the catalogue import (a quick entry is absolute, so only
   * sanity limits apply). Returns (per_100 with all eight keys, extra). */
  nutrients(values: unknown, factor: number, strict = true): [Record<string, number | null>, Record<string, number>] {
    const per100: Record<string, number | null> = Object.fromEntries(PER_100_KEYS.map((k) => [k, null]));
    if (!isDict(values)) return [per100, {}];
    for (const [yazioKey, key] of Object.entries(CORE)) {
      if (!Object.hasOwn(values, yazioKey)) continue;
      const number = parseNumber(values[yazioKey]);
      if (number === null) { this.summary.dropped_values++; continue; }
      const value = roundHalfEven(number * factor, 6);
      let top = key === 'kcal' ? MAX_KCAL_100 : MAX_GRAMS_100;
      if (!strict) top = key === 'kcal' ? GOAL_KCAL[1] : 5 * GOAL_GRAMS[1];
      if (!(value >= 0 && value <= top)) { this.summary.dropped_values++; continue; }
      per100[key] = value;
    }
    for (const key of Object.keys(values)) if (!Object.hasOwn(CORE, key) && !YAZIO_KEYS.has(key)) bump(this.summary.unknown_keys, key);
    const [extra, dropped] = extraFromYazio(values, factor, per100.fat, per100.carbs);
    this.summary.dropped_values += dropped;
    return [per100, extra];
  }
}

interface FoodData extends Record<string, unknown> { name: string; brand: string | null; unit: string; per_100: Record<string, number | null>; extra: Record<string, number> }

function foodData(name: string | null, brand: string | null, serving: [number, string] | null, unit: string, per100: Record<string, number | null>, extra: Record<string, number>): FoodData {
  return {
    name: name || '?', brand, quantity: null, serving_size: serving ? `${formatG(serving[0])} ${serving[1]}` : null,
    serving_quantity: serving ? serving[0] : null, unit, per_100: per100, extra, complete: isComplete(per100),
  };
}

/** The portion of a product: `portion` if there is one, else the first usable one. */
function firstServing(servings: unknown, unit: string): [number, string] | null {
  const usable: [unknown, number][] = [];
  for (const item of Array.isArray(servings) ? servings : []) {
    const amount = isDict(item) ? parseNumber(item.amount) : null;
    if (amount !== null && amount > 0 && amount <= 5000) usable.push([item.serving, amount]);
  }
  usable.sort((a, b) => Number(a[0] !== 'portion') - Number(b[0] !== 'portion')); // stable: `portion` first, the rest in file order
  return usable.length ? [usable[0]![1], unit] : null;
}

/** A number above 0 and at most `top`, else null. */
function positive(value: unknown, top: number): number | null {
  const number = parseNumber(value);
  return number !== null && number > 0 && number <= top ? number : null;
}

type Loaded = Record<string, Record<string, any> | null | undefined>;

/** Prepare everything `importYazio` writes from the parsed files (`FILES` -> object or null). With `refresh` (only from a direct sign-in that
 * fetched every day of the period) the plan also carries the ids Yazio listed for these days, ALL of them, also those this importer skips
 * (`seen_entries`: the entry ids; `seen_workouts`: `yazio:<id>`): a row whose id is not among them is gone in Yazio, a skipped but listed
 * one is not. */
export function buildPlan(loaded: Loaded, allProducts: boolean, summary: Summary, where = 'the export', refresh: Refresh | null = null): Plan {
  summary.missing_files = FILES.filter((name) => (loaded[name] ?? null) === null);
  if (summary.missing_files.length === FILES.length) throw new YazioError(`${where}: none of ${FILES.join(', ')} found`);
  const catalog = loaded['products.json'] ?? {};
  const products = isDict(catalog.products) ? catalog.products : {};
  const recipes = isDict(catalog.recipes) ? catalog.recipes : {};
  const days = loaded['days.json'] ?? {};
  const convert = new Convert(summary);

  const foods = new Map<string, PlanFood>();
  const recipeGrams = new Map<string, number>();

  const productFood = (uuid: unknown): [string, FoodData] | null => {
    const key = `yazio:product:${text(uuid)}`;
    if (!foods.has(key)) {
      const product = typeof uuid === 'string' ? get(products, uuid) : undefined;
      if (!isDict(product)) return null;
      const unit = product.base_unit === 'g' || product.base_unit === 'ml' ? product.base_unit : 'g';
      const [per100, extra] = convert.nutrients(product.nutrients, 100);
      const eans = product.eans;
      const ean = Array.isArray(eans) && eans.length && typeof eans[0] === 'string' ? pyStrip(eans[0]) : '';
      foods.set(key, {
        code: /^\p{Nd}+$/u.test(ean) && pyLen(ean) <= 14 ? ean : null,
        data: foodData(clean(product.name), clean(product.producer), firstServing(product.servings, unit), unit, per100, extra),
      });
    }
    return [key, foods.get(key)!.data as FoodData];
  };

  /** (key, food data, grams per portion). The portion weight is the sum of the ingredients / portions. */
  const recipeFood = (uuid: unknown): [string, FoodData, number] | null => {
    const key = `yazio:recipe:${text(uuid)}`;
    const recipe = typeof uuid === 'string' ? get(recipes, uuid) : undefined;
    if (!isDict(recipe)) return null;
    if (!foods.has(key)) {
      const portions = parseNumber(recipe.portion_count);
      const ingredients = Array.isArray(recipe.servings) ? recipe.servings : [];
      const total = pySum(ingredients.flatMap((i) => {
        const a = isDict(i) ? parseNumber(i.amount) : null;
        return a !== null && a > 0 ? [a] : [];
      }));
      const grams = portions && portions > 0 && total > 0 ? total / portions : QUICK_PORTION;
      const [per100, extra] = convert.nutrients(recipe.nutrients, 100 / grams);
      foods.set(key, { code: null, data: foodData(clean(recipe.name), null, [roundHalfEven(grams, 4), 'g'], 'g', per100, extra) });
      recipeGrams.set(key, grams);
    }
    return [key, foods.get(key)!.data as FoodData, recipeGrams.get(key)!];
  };

  const entries: PlanEntry[] = [];
  const skip = summary.skipped;
  const seenEntries = new Set<string>(), seenWorkouts = new Set<string>();
  const water: Plan['water'] = [];
  const activity: Plan['activity'] = [];
  const workouts: PlanWorkout[] = [];
  const validDays: string[] = [];
  for (const day of Object.keys(days).sort()) {
    const content = days[day];
    if (!isDay(day) || !isDict(content)) { bump(skip, 'day with an invalid date or shape'); continue; }
    validDays.push(day);
    const consumed = isDict(content.consumed) ? content.consumed : {};
    const found: [string, unknown, 'product' | 'recipe' | 'quick'][] = [];
    for (const [kind, name] of [['product', 'products'], ['recipe', 'recipe_portions'], ['quick', 'simple_products']] as const) {
      for (const item of Array.isArray(consumed[name]) ? consumed[name] : []) found.push([isDict(item) ? (Object.hasOwn(item, 'date') ? text(item.date) : '') : '', item, kind]);
    }
    found.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); // by time of day; stable for equal times
    for (const [, item, kind] of found) {
      if (isDict(item) && truthy(item.id)) seenEntries.add(text(item.id)); // before the importer may skip it
      const entry = makeEntry(item, kind, day, productFood, recipeFood, convert, skip, summary, truthy(catalog));
      if (entry) entries.push(entry);
    }
    const block = isDict(content.daily_summary) ? content.daily_summary : {};
    const ml = parseNumber(block.water_intake);
    if (ml && ml > 0) {
      if (ml <= MAX_WATER_ML) water.push({ day, ml: roundHalfEven(ml) });
      else bump(skip, 'water amount above 10 l');
    }
    const exercises = isDict(content.exercises) ? content.exercises : {};
    const dayActivity = activityDay(day, block, exercises.activity, skip);
    if (dayActivity) activity.push(dayActivity);
    for (const listName of ['training', 'custom_training']) {
      for (const item of Array.isArray(exercises[listName]) ? exercises[listName] : []) {
        if (isDict(item) && truthy(item.id)) seenWorkouts.add(`yazio:${text(item.id)}`);
        const workout = makeWorkout(item, day, skip);
        if (workout) workouts.push(workout);
      }
    }
  }

  if (allProducts) for (const uuid of Object.keys(products)) productFood(uuid);

  const weights: Plan['weights'] = [];
  const weightFile = loaded['weight.json'] ?? {};
  for (const day of Object.keys(weightFile)) {
    const value = parseNumber(weightFile[day]);
    if (!isDay(day) || value === null || !(value >= WEIGHT_RANGE[0] && value <= WEIGHT_RANGE[1])) bump(skip, 'weight with an invalid date or value');
    else weights.push({ day, kg: roundHalfEven(value, 2) });
  }

  if (refresh !== null) {
    const wanted = dayRange(refresh.first_day, refresh.last_day);
    if (!wanted.length || wanted.some((d) => !validDays.includes(d))) throw new YazioError(`${where}: the fetched days do not cover the period of the refresh`);
    summary.refresh = { ...refresh };
    summary.entries_seen = seenEntries.size;
    summary.workouts_seen = seenWorkouts.size;
  }

  return {
    foods, entries, weights, water, all_products: allProducts, goal: goalOf(days, validDays), activity, workouts,
    refresh: refresh !== null ? { ...refresh } : null, seen_entries: seenEntries, seen_workouts: seenWorkouts,
  };
}

/** Every day from `first` to `last` (inclusive); empty when either is no date or the order is wrong (or more than 400 days). */
function dayRange(first: string, last: string): string[] {
  const a = isDay(first) ? dayToDate(first) : null, b = isDay(last) ? dayToDate(last) : null;
  if (a === null || b === null) return [];
  const span = Math.round((b.getTime() - a.getTime()) / 86400000);
  if (span < 0 || span > 400) return [];
  return Array.from({ length: span + 1 }, (_, i) => new Date(a.getTime() + i * 86400000).toISOString().slice(0, 10));
}

/** Steps, active energy and distance of one day: the daily summary first, the day's activity as a fallback. */
function activityDay(day: string, block: Record<string, any>, activity: unknown, skip: Counter): Plan['activity'][number] | null {
  const a = isDict(activity) ? activity : {};
  const steps = positive(block.steps, act.MAX_STEPS) ?? positive(a.steps, act.MAX_STEPS);
  const energy = positive(block.activity_energy, act.MAX_ACTIVE_KCAL) ?? positive(a.energy, act.MAX_ACTIVE_KCAL);
  const distance = positive(a.distance, act.MAX_DISTANCE_M);
  if (steps === null && energy === null && distance === null) {
    if ([block.steps, block.activity_energy, a.steps, a.energy, a.distance].some((v) => (parseNumber(v) ?? 0) > 0)) bump(skip, 'activity values out of range');
    return null;
  }
  return {
    day, steps: steps !== null ? roundHalfEven(steps) : null, active_kcal: energy !== null ? roundHalfEven(energy, 1) : null,
    distance_m: distance !== null ? roundHalfEven(distance, 1) : null,
  };
}

const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:.(\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d{1,6})\d*)?)?)?)?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2}(?:[.,]\d{1,6})?)?)?)?$/;

/** The moment of a date-time WITH an offset as unix seconds (datetime.fromisoformat); null without an offset (no guessing a zone) or when unreadable. */
function startedAt(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = ISO_TIME.exec(value);
  if (!m || m[8] === undefined) return null;
  const [y, mo, d, h = '0', mi = '0', s = '0'] = [m[1]!, m[2]!, m[3]!, m[4], m[5], m[6]];
  if (dayToDate(`${y}-${mo}-${d}`) === null || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
  let offset = 0;
  if (m[8] !== 'Z') {
    const parts = /^([+-])(\d{2}):?(\d{2})?:?(\d{2})?/.exec(m[8])!;
    const [oh, om, os] = [Number(parts[2]), Number(parts[3] ?? 0), Number(parts[4] ?? 0)];
    if (oh > 23 || om > 59 || os > 59) return null;
    offset = (parts[1] === '-' ? -1 : 1) * (oh * 3600 + om * 60 + os);
  }
  const t = new Date(0);
  t.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
  t.setUTCHours(Number(h), Number(mi), Number(s), 0);
  const fraction = m[7] ? Number('0.' + m[7]) : 0;
  return Math.trunc(t.getTime() / 1000 - offset + fraction);
}

function makeWorkout(item: unknown, day: string, skip: Counter): PlanWorkout | null {
  if (!isDict(item) || !truthy(item.id)) { bump(skip, 'training without id'); return null; }
  const minutes = positive(item.duration, act.MAX_MINUTES);
  if (minutes === null) { bump(skip, 'training without a usable duration'); return null; }
  const [kind, keptName] = act.resolveKind(clean(item.name, 100), null);
  const steps = positive(item.steps, act.MAX_STEPS);
  return {
    external_id: `yazio:${text(item.id)}`, day, started_at: startedAt(item.date), kind, name: keptName, minutes,
    kcal: positive(item.energy, act.MAX_WORKOUT_KCAL), distance_m: positive(item.distance, act.MAX_DISTANCE_M),
    steps: steps !== null ? roundHalfEven(steps) : null, note: clean(item.note, 500),
  };
}

function makeEntry(item: unknown, kind: 'product' | 'recipe' | 'quick', day: string, productFood: (u: unknown) => [string, FoodData] | null,
  recipeFood: (u: unknown) => [string, FoodData, number] | null, convert: Convert, skip: Counter, summary: Summary, haveCatalog: boolean): PlanEntry | null {
  if (!isDict(item) || !truthy(item.id)) { bump(skip, 'entry without id'); return null; }
  let meal = item.daytime;
  if (typeof meal !== 'string' || !(MEALS as readonly string[]).includes(meal)) {
    meal = 'snack';
    bump(summary.notes, 'entry with an unknown meal put into snack');
  }
  const base = { kind, external_id: text(item.id), day, meal: meal as string };
  if (kind === 'product') {
    const hit = productFood(item.product_id);
    if (hit === null) { bump(skip, haveCatalog ? 'product not in products.json' : 'products.json missing'); return null; }
    const [key, data] = hit;
    const amount = parseNumber(item.amount);
    if (amount === null || !(amount > 0 && amount <= MAX_AMOUNT)) { bump(skip, 'entry with an invalid amount'); return null; }
    return { ...base, food_key: key, amount, unit: data.unit, name: data.name, brand: data.brand, per_100: data.per_100, extra: data.extra };
  }
  if (kind === 'recipe') {
    const hit = recipeFood(item.recipe_id);
    if (hit === null) { bump(skip, haveCatalog ? 'recipe not in products.json' : 'products.json missing'); return null; }
    const [key, data, grams] = hit;
    const portions = parseNumber(item.portion_count);
    if (portions === null || !(portions > 0 && portions <= MAX_PORTIONS)) { bump(skip, 'entry with an invalid portion count'); return null; }
    return { ...base, food_key: key, amount: roundHalfEven(portions * grams, 6), unit: 'g', name: data.name, brand: null, per_100: data.per_100, extra: data.extra };
  }
  const values = item.nutrients;
  if (!isDict(values) || parseNumber(values['energy.energy']) === null) { bump(skip, 'quick entry without energy value'); return null; }
  const [per100, extra] = convert.nutrients(values, 1.0, false);
  if (per100.kcal === null) { bump(skip, 'quick entry with an unusable energy value'); return null; }
  return { ...base, food_key: null, amount: QUICK_PORTION, unit: 'g', name: clean(item.name) || '?', brand: null, per_100: per100, extra };
}

/** The goal of the most recent day that has a usable one. */
function goalOf(days: Record<string, any>, validDays: string[]): PlanGoal | null {
  for (const day of [...validDays].reverse()) {
    const block = days[day].daily_summary;
    const goals = isDict(block) ? block.goals : null;
    if (!isDict(goals)) continue;
    const [kcal, protein, carbs, fat] = ['energy.energy', 'nutrient.protein', 'nutrient.carb', 'nutrient.fat'].map((k) => parseNumber(goals[k]));
    if (kcal === null || !(kcal >= GOAL_KCAL[0] && kcal <= GOAL_KCAL[1])) continue;
    if ([protein, carbs, fat].some((v) => v === null || !(v >= GOAL_GRAMS[0] && v <= GOAL_GRAMS[1]))) continue;
    let water = parseNumber(goals.water);
    if (water === null || !(water >= GOAL_WATER[0] && water <= GOAL_WATER[1])) water = DEFAULT_WATER_GOAL;
    let steps = parseNumber(goals['activity.step']);
    steps = steps !== null && steps >= act.STEPS_GOAL_RANGE[0] && steps <= act.STEPS_GOAL_RANGE[1] ? roundHalfEven(steps) : null;
    return { kcal: roundHalfEven(kcal), protein: protein!, carbs: carbs!, fat: fat!, water_ml: roundHalfEven(water), steps };
  }
  return null;
}

/** Import parsed export files into the account of one user (with `dryRun`: count only, write nothing). */
export async function runImportFrom(db: Db, userId: number, loaded: Loaded, allProducts = false, dryRun = false, where = 'the export', refresh: Refresh | null = null): Promise<Summary> {
  const summary = newSummary(dryRun);
  const plan = buildPlan(loaded, allProducts, summary, where, refresh);
  const r = await importYazio(db, userId, plan, dryRun);
  summary.days = r.days;
  summary.entries = { product: r.product_entries, recipe: r.recipe_entries, quick: r.quick_entries };
  summary.total_entries = r.product_entries + r.recipe_entries + r.quick_entries;
  summary.foods_created = r.foods;
  summary.foods_reused = r.foods_reused;
  summary.weights = r.weights;
  summary.weights_updated = r.weights_updated;
  summary.weights_kept = plan.weights.length - r.weights - r.weights_updated;
  summary.water = r.water;
  summary.water_updated = r.water_updated;
  summary.water_kept = plan.water.length - r.water - r.water_updated;
  summary.entries_updated = r.entries_updated;
  summary.entries_removed = r.entries_removed;
  summary.workouts_updated = r.workouts_updated;
  summary.workouts_removed = r.workouts_removed;
  summary.activity_updated = r.activity_updated;
  summary.goal_set = r.goal_set;
  summary.activity_days = r.activity_days;
  summary.activity_kept = r.activity_kept;
  summary.workouts = r.workouts;
  summary.workouts_already = r.workouts_already;
  summary.already_imported = r.already_imported;
  summary.batch_id = r.batch_id;
  return summary;
}
