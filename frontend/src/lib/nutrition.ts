import type { Per100 } from './types';

export const ROWS: [keyof Per100, string, boolean][] = [
  ['kcal', 'kcal', false], ['fat', 'g', false], ['saturated_fat', 'g', true], ['carbs', 'g', false],
  ['sugars', 'g', true], ['fiber', 'g', false], ['protein', 'g', false], ['salt', 'g', false],
];

export interface Ingredient {
  per_100: Partial<Per100>;
  amount: number;
}
interface Macros { kcal: number | null; protein: number | null; carbs: number | null; fat: number | null }

/**
 * Live preview of a recipe, the same calculation as the server: a value is only known when at least one ingredient
 * states it. `weight` is the finished dish if given, else the sum of the ingredients.
 */
export function recipePreview(items: Ingredient[], portions: number, totalWeight: number | null) {
  const sum = items.reduce((s, i) => s + i.amount, 0);
  const reference = totalWeight && totalWeight > 0 ? totalWeight : sum;
  const per100 = {} as Macros;
  const perPortion = {} as Macros;
  for (const key of ['kcal', 'protein', 'carbs', 'fat'] as const) {
    const known = items.filter((i) => i.per_100[key] != null);
    const total = known.reduce((s, i) => s + ((i.per_100[key] as number) * i.amount) / 100, 0);
    per100[key] = known.length && reference > 0 ? (total / reference) * 100 : null;
    perPortion[key] = known.length && portions > 0 ? total / portions : null;
  }
  return { reference, per100, perPortion, serving: portions > 0 && reference > 0 ? reference / portions : null };
}
