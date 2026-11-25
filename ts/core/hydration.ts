// Drinks of the diary that count towards the day's fluid total (hydration.py). Computed on read, nothing is written to
// the water table. Only entries in ml are looked at:
//  * the food's own setting decides first: `drink` 0 never counts, 1 always (amount x water share, or the whole amount
//    when the water content is unknown);
//  * without a setting the entry counts when it is no soup, has at most ALCOHOL_MAX g alcohol per 100 and either holds at
//    least WATER_MIN % water or, when the content is unknown, looks like a plain drink (`plainDrink`).
import type { Db } from './db.ts';
import { roundHalfEven } from './num.ts';
import { getSettings } from './store/settings.ts';
import { drinkEntries, type DrinkEntry } from './store/diary.ts';

export const WATER_MIN = 80.0; // % water per 100 g/ml for the automatic rule
export const ALCOHOL_MAX = 0.5; // g alcohol per 100 g/ml
// fallback without a water content: milk 65 kcal, juice 45 and cola 42 pass; soy sauce, ketchup, oil do not
const FALLBACK_KCAL_MAX = 70.0;
const FALLBACK_SALT_MAX = 0.5; // keeps soy sauce and stock out although they have few kcal
const FALLBACK_PROTEIN_MAX = 5.0; // keeps skyr and quark out (milk has 3.4, soy and oat drinks less)

const SOUP = /suppe|soup|eintopf|br[uü]he|bouillon|consomm[eé]|broth|stew|chowder|bisque|gazpacho/iu;

export const isSoup = (name: string | null | undefined): boolean => Boolean(name && SOUP.test(name));

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** % water per 100 g/ml: the entry's own value, else what its food says; null when neither knows it. */
export function waterContent(entry: DrinkEntry): number | null {
  for (const extra of [entry.extra, entry.food_extra]) {
    const v = num(extra?.water);
    if (v !== null) return Math.min(Math.max(v, 0.0), 100.0);
  }
  return null;
}

export function alcoholContent(entry: DrinkEntry): number {
  for (const extra of [entry.extra, entry.food_extra]) {
    const v = num(extra?.alcohol);
    if (v !== null) return v;
  }
  return 0.0;
}

/** For an unknown water content: few kcal, hardly any salt and not much protein per 100 (nothing known about the energy: no). */
export function plainDrink(entry: DrinkEntry): boolean {
  const per100 = entry.per_100 ?? {};
  const kcal = num(per100.kcal);
  return kcal !== null && kcal <= FALLBACK_KCAL_MAX && (num(per100.salt) || 0) <= FALLBACK_SALT_MAX && (num(per100.protein) || 0) <= FALLBACK_PROTEIN_MAX;
}

/** The water (ml) one entry adds to the fluid total. */
export function drinkMl(entry: DrinkEntry): number {
  const drink = entry.drink;
  if (drink !== null && drink !== undefined && !drink) return 0.0;
  const content = waterContent(entry);
  if (drink === null || drink === undefined) {
    if (isSoup(entry.name) || alcoholContent(entry) > ALCOHOL_MAX) return 0.0;
    if (!(content !== null ? content >= WATER_MIN : plainDrink(entry))) return 0.0;
  }
  const share = content === null ? 1.0 : content / 100;
  return Number(entry.amount) * share;
}

/** Whole ml per day for the entries `drinkEntries` returns. */
export function drinksByDay(entries: DrinkEntry[]): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const e of entries) {
    const ml = drinkMl(e);
    if (ml > 0) sums[e.day] = (sums[e.day] ?? 0) + ml;
  }
  return Object.fromEntries(Object.entries(sums).map(([day, ml]) => [day, roundHalfEven(ml)]));
}

/** The setting `water_drinks` (on unless set to something false). */
export const waterDrinksOn = (settings: Record<string, unknown>): boolean => !Object.hasOwn(settings, 'water_drinks') || Boolean(settings.water_drinks);

/** The drinks of one day (0 when the user switched the feature off with the setting `water_drinks`). */
export async function dayDrinksMl(db: Db, userId: number, day: string): Promise<number> {
  if (!waterDrinksOn(await getSettings(db, userId))) return 0;
  return drinksByDay(await drinkEntries(db, userId, day, day))[day] ?? 0;
}
