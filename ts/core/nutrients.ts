// Directory of the additional nutrients (nutrients.py): the part the diary and the food routes need. The importers
// (Open Food Facts, BLS conversions) come with the packages that use them; the Yazio ones are here.
import { pySum, roundHalfEven } from './num.ts';

export interface Nutrient { key: string; group: string; unit: string; nrv: number | null; off: string | null; yazio: string | null; max: number }

// key, group, unit, nrv, off column, yazio key, plausible maximum per 100 g/ml
const n = (key: string, group: string, unit: string, nrv: number | null, off: string | null, yazio: string | null, max: number): Nutrient =>
  ({ key, group, unit, nrv, off, yazio, max });

export const NUTRIENTS: readonly Nutrient[] = [
  n('monounsaturated_fat', 'fat', 'g', null, 'monounsaturated-fat_100g', 'nutrient.monounsaturated', 100),
  n('polyunsaturated_fat', 'fat', 'g', null, 'polyunsaturated-fat_100g', 'nutrient.polyunsaturated', 100),
  n('trans_fat', 'fat', 'g', null, 'trans-fat_100g', 'nutrient.transfat', 100),
  n('cholesterol', 'fat', 'mg', null, 'cholesterol_100g', 'nutrient.cholesterol', 5000),
  n('omega_3', 'fat', 'g', null, 'omega-3-fat_100g', null, 100),
  n('added_sugars', 'carb', 'g', null, 'added-sugars_100g', 'nutrient.addedsugar', 100),
  n('starch', 'carb', 'g', null, 'starch_100g', null, 100),
  n('alcohol', 'other', 'g', null, 'alcohol_100g', 'nutrient.alcohol', 100),
  n('water', 'other', 'g', null, 'water_100g', 'nutrient.water', 100),
  n('sodium', 'other', 'mg', null, 'sodium_100g', 'nutrient.sodium', 40000),
  n('caffeine', 'other', 'mg', null, 'caffeine_100g', null, 5000),
  n('calcium', 'mineral', 'mg', 800, 'calcium_100g', 'mineral.calcium', 10000),
  n('iron', 'mineral', 'mg', 14, 'iron_100g', 'mineral.iron', 500),
  n('potassium', 'mineral', 'mg', 2000, 'potassium_100g', 'mineral.potassium', 20000),
  n('magnesium', 'mineral', 'mg', 375, 'magnesium_100g', 'mineral.magnesium', 5000),
  n('zinc', 'mineral', 'mg', 10, 'zinc_100g', 'mineral.zinc', 300),
  n('phosphorus', 'mineral', 'mg', 700, 'phosphorus_100g', 'mineral.phosphorus', 5000),
  n('iodine', 'mineral', 'µg', 150, 'iodine_100g', 'mineral.iodine', 200000),
  n('copper', 'mineral', 'mg', 1, 'copper_100g', 'mineral.copper', 50),
  n('manganese', 'mineral', 'mg', 2, 'manganese_100g', 'mineral.manganese', 100),
  n('selenium', 'mineral', 'µg', 55, 'selenium_100g', 'mineral.selenium', 5000),
  n('chloride', 'mineral', 'mg', 800, 'chloride_100g', 'mineral.chlorine', 40000),
  n('fluoride', 'mineral', 'mg', 3.5, 'fluoride_100g', 'mineral.fluoride', 50),
  n('chromium', 'mineral', 'µg', 40, 'chromium_100g', 'mineral.chrome', 2000),
  n('molybdenum', 'mineral', 'µg', 50, 'molybdenum_100g', 'mineral.molybdenum', 2000),
  n('vitamin_a', 'vitamin', 'µg', 800, 'vitamin-a_100g', 'vitamin.a', 100000),
  n('vitamin_b1', 'vitamin', 'mg', 1.1, 'vitamin-b1_100g', 'vitamin.b1', 100),
  n('vitamin_b2', 'vitamin', 'mg', 1.4, 'vitamin-b2_100g', 'vitamin.b2', 100),
  n('vitamin_b3', 'vitamin', 'mg', 16, 'vitamin-pp_100g', 'vitamin.b3', 500),
  n('vitamin_b5', 'vitamin', 'mg', 6, 'pantothenic-acid_100g', 'vitamin.b5', 100),
  n('vitamin_b6', 'vitamin', 'mg', 1.4, 'vitamin-b6_100g', 'vitamin.b6', 100),
  n('vitamin_b7', 'vitamin', 'µg', 50, 'biotin_100g', 'vitamin.b7', 5000),
  n('vitamin_b9', 'vitamin', 'µg', 200, 'vitamin-b9_100g', 'vitamin.b11', 10000),
  n('vitamin_b12', 'vitamin', 'µg', 2.5, 'vitamin-b12_100g', 'vitamin.b12', 5000),
  n('vitamin_c', 'vitamin', 'mg', 80, 'vitamin-c_100g', 'vitamin.c', 10000),
  n('vitamin_d', 'vitamin', 'µg', 5, 'vitamin-d_100g', 'vitamin.d', 1000),
  n('vitamin_e', 'vitamin', 'mg', 12, 'vitamin-e_100g', 'vitamin.e', 1000),
  n('vitamin_k', 'vitamin', 'µg', 75, 'vitamin-k_100g', 'vitamin.k', 10000),
];

export const BY_KEY: ReadonlyMap<string, Nutrient> = new Map(NUTRIENTS.map((x) => [x.key, x]));
export const KEYS: readonly string[] = NUTRIENTS.map((x) => x.key);

export type Extra = Record<string, number>;

export const plausible = (key: string, value: number): boolean => BY_KEY.has(key) && value >= 0 && value <= BY_KEY.get(key)!.max;

/** Stored `extra` as a plain object of known, plausible numbers (older rows have none). */
export function clean(extra: unknown): Extra {
  if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) return {};
  return Object.fromEntries(Object.entries(extra).filter(([k, v]) => typeof v === 'number' && plausible(k, v))) as Extra;
}

/** Nutrients for `amount` g/ml. */
export const scaleExtra = (extra: Extra, amount: number): Extra =>
  Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, (v * amount) / 100]));

/** Sum scaled extra nutrients and measure how much of the energy they are known for. `parts` are (kcal, scaled extra) per
 * diary entry. Returns {key: {amount, coverage}} for the keys at least one entry knows, in directory order. `coverage`
 * (0..1) is the share of the entries' kcal from entries with a value for the key (by entry count when no entry has kcal). */
export function aggregate(parts: [number, Extra][]): Record<string, { amount: number; coverage: number }> {
  const kcalTotal = pySum(parts.map(([kcal]) => kcal));
  const byEnergy = kcalTotal > 0;
  const whole = byEnergy ? kcalTotal : parts.length;
  const sums: Record<string, number> = {};
  const known: Record<string, number> = {};
  for (const [kcal, extra] of parts) {
    for (const [key, value] of Object.entries(extra)) {
      if (!BY_KEY.has(key)) continue; // a key this version does not know (stored by another one)
      sums[key] = (sums[key] ?? 0) + value;
      known[key] = (known[key] ?? 0) + (byEnergy ? kcal : 1);
    }
  }
  return Object.fromEntries(Object.keys(sums).sort((a, b) => KEYS.indexOf(a) - KEYS.indexOf(b)).map((key) => [
    key, { amount: sums[key], coverage: whole ? Math.min(1, known[key] / whole) : 0 },
  ]));
}

// --- Open Food Facts values (the importers of Yazio and BLS come with their packages) ---

const UNIT_FACTOR: Record<string, number> = { g: 1, mg: 1e3, 'µg': 1e6 }; // grams -> unit
const PARTS_OF_FAT = ['monounsaturated_fat', 'polyunsaturated_fat', 'trans_fat', 'omega_3'];
const PARTS_OF_CARBS = ['added_sugars', 'starch'];
const TOLERANCE = 1.0;
const FLOAT_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** A finite float from text or a number, otherwise null. No rounding. */
export function parseNumber(value: unknown): number | null {
  let n: number;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!FLOAT_TEXT.test(s)) return null;
    n = Number(s);
  } else if (typeof value === 'number') n = value;
  else if (typeof value === 'boolean') n = Number(value);
  else return null;
  return Number.isFinite(n) ? n : null;
}

/** Open Food Facts gives grams per 100 g; the value in the nutrient's unit, or null when missing, negative or implausibly large. */
export function fromOff(key: string, grams: number | null): number | null {
  const nutrient = BY_KEY.get(key);
  if (grams === null || !nutrient || grams < 0) return null;
  const value = roundHalfEven(grams * UNIT_FACTOR[nutrient.unit]!, 4);
  return value <= nutrient.max ? value : null;
}

/** Additional nutrients of one Open Food Facts product; `lookup(column)` gives the grams of an OFF column. */
export function extraFromOff(lookup: (column: string) => number | null, fat: number | null = null, carbs: number | null = null): Extra {
  const result: Extra = {};
  for (const x of NUTRIENTS) {
    if (!x.off) continue;
    const value = fromOff(x.key, lookup(x.off));
    if (value === null) continue;
    if (fat !== null && PARTS_OF_FAT.includes(x.key) && value > fat + TOLERANCE) continue;
    if (carbs !== null && PARTS_OF_CARBS.includes(x.key) && value > carbs + TOLERANCE) continue;
    result[x.key] = value;
  }
  return result;
}

// --- Yazio export values (yazio.py imports them) ---

// Yazio uses more than one spelling for some minerals; the first one is listed on the nutrient itself.
const YAZIO_ALIASES: Record<string, string> = { 'mineral.fluorine': 'fluoride' };
export const YAZIO_KEYS: ReadonlyMap<string, string> = new Map([
  ...NUTRIENTS.filter((x) => x.yazio).map((x): [string, string] => [x.yazio!, x.key]),
  ...Object.entries(YAZIO_ALIASES),
]);

/** Additional nutrients from a Yazio nutrient object, and how many values had to be discarded. `values` maps Yazio keys to grams;
 * `per` turns such a value into grams per 100 g/ml (100 for the Yazio per-gram products, 1 for the absolute values of an entry that is
 * stored as exactly 100 g). Keys without a counterpart here are ignored (the caller counts them). A value that is not a number, is
 * negative, implausibly large or larger than its parent (`fat`, `carbs` in g) is discarded and counted. */
export function extraFromYazio(values: Record<string, unknown>, per: number, fat: number | null = null, carbs: number | null = null): [Extra, number] {
  const result: Extra = {};
  let dropped = 0;
  for (const [yazioKey, raw] of Object.entries(values)) {
    const key = YAZIO_KEYS.get(yazioKey);
    if (key === undefined) continue;
    const number = parseNumber(raw);
    const value = number === null ? null : fromOff(key, number * per);
    if (value === null) dropped++;
    else if (fat !== null && PARTS_OF_FAT.includes(key) && value > fat + TOLERANCE) dropped++;
    else if (carbs !== null && PARTS_OF_CARBS.includes(key) && value > carbs + TOLERANCE) dropped++;
    else result[key] = value;
  }
  return [result, dropped];
}
