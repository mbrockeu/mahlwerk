// models.py: entries and the day view. Request bodies as zod schemas, responses as types in the order of the pydantic fields.
import { z } from 'zod';
import type { Per100Key } from '../nutrition.ts';
import { mealSchema, nullish, pyFloat, pyInt, type Meal, type Unit } from './common.ts';
import type { DayActivity } from './activity.ts';

const amount = () => pyFloat().pipe(z.number().gt(0).max(5000));

export const entryIn = z.object({ food_id: pyInt(), meal: mealSchema, amount: amount() });
export const entryPatch = z.object({ amount: nullish(amount()), meal: nullish(mealSchema), food_id: nullish(pyInt()) });
export const copyIn = z.object({ from_day: z.string(), meal: nullish(mealSchema), to_meal: nullish(mealSchema) });

export interface Entry {
  id: number; food_id: number | null; meal: Meal; name: string; brand: string | null; amount: number; unit: Unit;
  kcal: number | null; protein: number | null; carbs: number | null; fat: number | null;
}

export interface Goal { kcal: number; protein: number; carbs: number; fat: number; water_ml: number; steps: number }

export interface Day {
  day: string;
  goal: Goal | null;
  kcal_goal: number | null;
  water: { ml: number; goal_ml: number; drinks_ml: number };
  activity: DayActivity;
  totals: Record<Per100Key, number>;
  extra_totals: Record<string, { amount: number; coverage: number }>;
  meals: Record<Meal, { kcal: number; entries: Entry[] }>;
  yesterday: Partial<Record<Meal, { kcal: number; names: string[] }>>;
  streak: number;
  week: { day: string; logged: boolean; kcal: number }[];
}

export interface HistoryDay { day: string; kcal: number; protein: number; carbs: number; fat: number; logged: boolean; water_ml: number; water_drinks_ml: number }
