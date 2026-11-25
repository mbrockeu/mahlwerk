// models.py: Per100In, FoodIn, FoodPiece, FoodDrink (request bodies) and the shape of Food / RecentFood (responses).
import { z } from 'zod';
import { BY_KEY, plausible, type Extra } from '../nutrients.ts';
import type { Per100Key } from '../nutrition.ts';
import { nullish, pyBool, pyFloat, pyStr, unitSchema, type Meal, type Unit } from './common.ts';

const grams = () => nullish(pyFloat().pipe(z.number().min(0).max(100)));

export const per100In = z.object({
  kcal: nullish(pyFloat().pipe(z.number().min(0).max(1000))),
  fat: grams(), saturated_fat: grams(), carbs: grams(), sugars: grams(), fiber: grams(), protein: grams(), salt: grams(),
});

/** The nutrient values must be known keys within their plausible range. */
const extraSchema = z.record(z.string(), pyFloat()).superRefine((extra, ctx) => {
  for (const [key, value] of Object.entries(extra)) { // one error for the field, like a pydantic field validator
    const n = BY_KEY.get(key);
    if (!n) return ctx.addIssue({ code: 'custom', message: `Value error, unknown nutrient: ${key}` });
    if (!plausible(key, value as number)) return ctx.addIssue({ code: 'custom', message: `Value error, ${key} must be between 0 and ${n.max} ${n.unit}` });
  }
});

/** A product entered or corrected by the user. `unit` stays undefined when it was not sent (own_data needs to know). */
export const foodIn = z.object({
  name: pyStr(1, 200),
  brand: nullish(pyStr(0, 200)),
  quantity: nullish(pyStr(0, 60)),
  serving_size: nullish(pyStr(0, 60)),
  serving_quantity: nullish(pyFloat().pipe(z.number().gt(0).max(5000))),
  unit: unitSchema.optional(),
  per_100: per100In,
  extra: extraSchema.default({}),
});
export type FoodIn = z.infer<typeof foodIn>;

/** What one piece of a food is ("slice" = 25 g). */
export const foodPiece = z.object({
  label: pyStr(1, 30).refine((s) => s.trim() !== '', { message: 'Value error, the label must not be empty' }).transform((s) => s.trim()),
  grams: pyFloat().pipe(z.number().gt(0).max(5000)),
});

export const foodDrink = z.object({ drink: pyBool().nullable() });

export interface FoodImage { hash: string; origin: 'own' | 'cookidoo' | 'web'; credit: string | null }

/** The API shape of a food, fields in the order of the pydantic model. */
export interface Food {
  id: number;
  code: string | null;
  source: 'openfoodfacts' | 'own' | 'recipe' | 'yazio' | 'bls' | 'cookidoo' | 'web';
  recipe_id: number | null;
  external_id: string | null;
  portions: number | null;
  url: string | null;
  name: string | null;
  brand: string | null;
  quantity: string | null;
  serving_size: string | null;
  serving_quantity: number | null;
  unit: Unit;
  per_100: Record<Per100Key, number | null>;
  extra: Extra;
  complete: boolean;
  empty: boolean;
  cached: boolean;
  stale: boolean;
  fetched_at: number;
  image: FoodImage | null;
  can_edit: boolean;
  image_removed: boolean;
  piece: { label: string; grams: number } | null;
  drink: boolean | null;
}

export interface RecentFood { food: Food; last_amount: number; last_meal: Meal }
