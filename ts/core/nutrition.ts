// Pure helpers (nutrition.py): barcode check, unit and serving detection, scaling nutrients to an amount.
import { pySum, roundHalfEven } from './num.ts';

export const PER_100_KEYS = ['kcal', 'fat', 'saturated_fat', 'carbs', 'sugars', 'fiber', 'protein', 'salt'] as const;
export const CORE = ['kcal', 'fat', 'carbs', 'protein'] as const;
export type Per100Key = (typeof PER_100_KEYS)[number];
/** Nutrients per 100 g/ml; a key that is missing or null is unknown. */
export type Per100 = Partial<Record<Per100Key, number | null>>;
export type Scaled = Record<Per100Key, number | null>;

const VOLUME = /\d\s*(?:ml|cl|dl|l|fl\.?\s*oz)\b/i;
const SERVING = /^\s*(\d+(?:[.,]\d+)?)\s*(g|ml)\b/i;

/** Length and the GS1 check digit (EAN-8, UPC-A, EAN-13, GTIN-14). */
export function validGtin(code: string): boolean {
  if (!/^[0-9]+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const digits = [...code].map(Number);
  const total = digits.slice(0, -1).reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (total % 10)) % 10 === digits.at(-1);
}

/** Liquids are measured in ml: either the table says so or the package size is a volume. */
export function guessUnit(per: string | null | undefined, quantity: string | null | undefined, servingSize: string | null | undefined): 'g' | 'ml' {
  if (per && per.replaceAll(' ', '').toLowerCase() === '100ml') return 'ml';
  if ([quantity, servingSize].some((t) => t && VOLUME.test(t))) return 'ml';
  return 'g';
}

/** '30 g' -> [30, 'g']; anything that is not a plain weight or volume gives null. */
export function parseServing(servingSize: string | null | undefined): [number, 'g' | 'ml'] | null {
  const m = SERVING.exec(servingSize ?? '');
  if (!m) return null;
  const value = Number(m[1].replace(',', '.'));
  return value > 0 ? [value, m[2].toLowerCase() as 'g' | 'ml'] : null;
}

export const isComplete = (per100: Per100): boolean => CORE.every((k) => per100[k] != null);

/** Nutrients for `amount` g/ml; missing values stay null. */
export function scale(per100: Per100, amount: number): Scaled {
  return Object.fromEntries(PER_100_KEYS.map((k) => [k, per100[k] == null ? null : (per100[k] * amount) / 100])) as Scaled;
}

/** Sum scaled nutrients; null counts as 0. */
export const total = (parts: Scaled[]): Record<Per100Key, number> =>
  Object.fromEntries(PER_100_KEYS.map((k) => [k, pySum(parts.map((p) => p[k] ?? 0))])) as Record<Per100Key, number>;

export const r1 = (value: number): number => roundHalfEven(value, 1);

export interface RecipeItem { amount: number; per_100: Per100; extra?: Record<string, number> | null }

/** Python's f"{x:g}" for the range a serving can have. */
const fmtG = (x: number): string => String(Number(x.toPrecision(6)));

/** Food data of a recipe, calculated from its ingredients. The reference weight is `totalWeight` (the cooked dish) or, without
 * it, the sum of the amounts. A value is only set when at least one ingredient states it (unknown, not zero). */
export function recipeFood(items: RecipeItem[], portions: number, totalWeight: number | null) {
  const weight = pySum(items.map((i) => i.amount));
  const reference = totalWeight || weight;
  const per100: Per100 = {};
  for (const key of PER_100_KEYS) {
    const known = items.filter((i) => i.per_100[key] != null).map((i) => i.per_100[key]! * i.amount);
    per100[key] = known.length ? roundHalfEven(pySum(known) / reference, 2) : null;
  }
  const sums: Record<string, number> = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item.extra ?? {})) sums[key] = (sums[key] ?? 0) + value * item.amount;
  }
  const extra = Object.fromEntries(Object.entries(sums).map(([key, value]) => [key, roundHalfEven(value / reference, 4)]));
  const serving = roundHalfEven(reference / portions, 2);
  return {
    name: null, // filled in by the caller
    brand: null,
    quantity: null,
    serving_size: `${fmtG(roundHalfEven(serving, 1))} g`,
    serving_quantity: serving,
    unit: 'g',
    per_100: per100,
    extra,
    complete: isComplete(per100),
  };
}
