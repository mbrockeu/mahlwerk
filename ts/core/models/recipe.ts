// models.py and routes/recipe_groups.py: templates, recipes, groups of recipes and the ingredient list (request bodies as zod schemas,
// responses as types in the order of the pydantic fields).
import { z } from 'zod';
import { MAX_LINE, MAX_LINES, MAX_TEXT } from '../ingredients.ts';
import { pyLen, pySplitLines, pyStrip } from '../text.ts';
import { mealSchema, nullish, pyBool, pyFloat, pyInt, pyStr, type Meal, type Unit } from './common.ts';
import type { Food } from './food.ts';

/** `Annotated[str, StringConstraints(strip_whitespace=True, min_length, max_length)]` */
const stripped = (min: number, max: number) => z.string().transform(pyStrip).pipe(pyStr(min, max));

// --- templates

const templateName = stripped(1, 80);
const templateFood = z.object({ food_id: pyInt(), amount: pyFloat().pipe(z.number().gt(0).max(5000)) });

/** Either `from` (a logged meal) or `items` (foods with amounts, e.g. a favourite combo); not both. `from_` is accepted as the field name too. */
export const templateIn = z.preprocess(
  (v) => (v && typeof v === 'object' && !Array.isArray(v) && 'from_' in v && !('from' in v) ? { ...v, from: (v as any).from_ } : v),
  z.object({
    name: templateName,
    from: nullish(z.object({ day: z.string(), meal: mealSchema })),
    items: nullish(z.array(templateFood).min(1).max(30)),
  }).superRefine((b, ctx) => {
    if ((b.from === null) === (b.items === null)) ctx.addIssue({ code: 'custom', message: 'Value error, give either `from` or `items`' });
  }),
);
export const templatePatch = z.object({ name: templateName });
export const templateApply = z.object({ day: z.string(), meal: mealSchema });

export interface TemplateItem { name: string; brand: string | null; amount: number; unit: Unit; kcal: number | null }
export interface Template { id: number; name: string; kcal: number; items: TemplateItem[] }

// --- recipes

export const recipeIn = z.object({
  name: stripped(1, 200),
  portions: pyFloat().pipe(z.number().gt(0).max(1000)),
  total_weight: nullish(pyFloat().pipe(z.number().gt(0).max(100000))),
  items: z.array(z.object({ food_id: pyInt(), amount: pyFloat().pipe(z.number().gt(0).max(20000)) })).min(1).max(60),
});

export interface RecipeItem { food_id: number | null; name: string; brand: string | null; amount: number; unit: Unit; kcal: number | null }
export interface Recipe {
  id: number; food: Food; portions: number; total_weight: number | null; items: RecipeItem[]; kcal_per_portion: number | null; can_edit: boolean;
}

// --- the ingredient list

export const ingredientsIn = z.object({
  recent: pyBool().default(false),
  text: z.string().superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message: `Value error, ${message}` });
    if (pyLen(value) > MAX_TEXT) return fail(`at most ${MAX_TEXT} characters`);
    const lines = pySplitLines(value);
    if (lines.length > MAX_LINES) return fail(`at most ${MAX_LINES} lines`);
    if (lines.some((l) => pyLen(l) > MAX_LINE)) return fail(`a line may have at most ${MAX_LINE} characters`);
  }),
});

export interface IngredientCandidate {
  source: string; food_id: number | null; code: string | null; name: string; brand: string | null; unit: Unit;
  per_100: Record<string, number | null>; eaten_count: number; eaten_last: string | null;
}
export interface IngredientLine {
  line: number; text: string; quantity: number | null; unit: string | null; name: string; note: string | null; optional: boolean;
  grams: number | null; ml: number | null; estimated: boolean; basis: string; candidates: IngredientCandidate[]; suggestion: IngredientCandidate | null;
}
export interface IngredientMatches { lines: IngredientLine[]; ignored: number }

// --- groups of recipes

export const MAX_GROUPS = 200;
export const MAX_MEMBERS_PER_CALL = 1000;

export const groupIn = z.object({ name: pyStr(1, 60) });
export const orderIn = z.object({ ids: z.array(pyInt()).max(MAX_GROUPS) });
export const membersIn = z.object({ food_ids: z.array(pyInt()).min(1).max(MAX_MEMBERS_PER_CALL) });
export const foodGroupsIn = z.object({ group_ids: z.array(pyInt()).max(MAX_GROUPS) });

export interface Group { id: number; name: string; position: number; auto: boolean; count: number; food_ids: number[]; can_edit: boolean }

// --- suggestions

export const FOCI = ['balanced', 'protein', 'light', 'rotation'] as const;
export type Focus = (typeof FOCI)[number];
export interface RestOut { kcal: number | null; protein: number | null; carbs: number | null; fat: number | null }
export interface SuggestionOut {
  food: Food; portions: number; amount: number; kcal: number; protein: number | null; carbs: number | null; fat: number | null;
  after: RestOut; reasons: string[]; score: number;
}
export interface Suggestions {
  day: string; state: 'ok' | 'goal_reached' | 'no_goal' | 'nothing_fits' | 'no_recipes'; focus: Focus; goal_kcal: number | null; rest: RestOut;
  candidates: number; items: SuggestionOut[];
}

// --- favourite combos

export interface ComboItem { food: Food; amount: number; kcal: number | null }
export interface Combo { items: ComboItem[]; kcal: number; days: number; last_day: string }

export type { Meal };
