// Where a day's protein, carbs or fat came from: per meal and the foods that gave the most. Pure, tested in
// tests/macroBreakdown.test.mjs; shown by MacroSheet (tap on a macro tile of the day view).
import type { Entry, Meal } from './types';

export type MacroKey = 'protein' | 'carbs' | 'fat';
export const MACRO_KEYS: MacroKey[] = ['protein', 'carbs', 'fat'];

export interface MealShare { meal: Meal; grams: number; share: number; entries: number }
export interface FoodShare { name: string; brand: string | null; grams: number; share: number }
export interface Breakdown { total: number; meals: MealShare[]; foods: FoodShare[] }

/** `meals` in the given order (all of them, empty ones with 0); `foods` the largest first, the same food summed over
 * its entries (by food id, else by name and brand), at most `top`; entries without a value count as 0. */
export function breakdown(meals: Meal[], entries: Record<Meal, Entry[]>, key: MacroKey, top = 5): Breakdown {
  const all = meals.flatMap((m) => entries[m] ?? []);
  const total = all.reduce((s, e) => s + (e[key] ?? 0), 0);
  const share = (g: number) => (total > 0 ? g / total : 0);
  const perMeal = meals.map((meal) => {
    const list = entries[meal] ?? [];
    const grams = list.reduce((s, e) => s + (e[key] ?? 0), 0);
    return { meal, grams, share: share(grams), entries: list.length };
  });
  const byFood = new Map<string, { name: string; brand: string | null; grams: number }>();
  for (const e of all) {
    const grams = e[key] ?? 0;
    if (grams <= 0) continue;
    const id = e.food_id != null ? `f${e.food_id}` : `n${e.name ?? ''}|${e.brand ?? ''}`;
    const item = byFood.get(id) ?? { name: e.name || '?', brand: e.brand, grams: 0 };
    item.grams += grams;
    byFood.set(id, item);
  }
  const foods = [...byFood.values()]
    .sort((a, b) => b.grams - a.grams || a.name.localeCompare(b.name))
    .slice(0, top)
    .map((f) => ({ ...f, share: share(f.grams) }));
  return { total, meals: perMeal, foods };
}
