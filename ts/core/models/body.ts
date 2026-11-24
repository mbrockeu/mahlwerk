// models.py: goal, weights, water, fasting, demo data and badges (request bodies as zod schemas).
import { z } from 'zod';
import { STEPS_GOAL_RANGE } from '../activity.ts';
import { roundHalfEven } from '../num.ts';
import { nullish, pyFloat, pyInt } from './common.ts';

const ranged = (min: number, max: number) => pyFloat().pipe(z.number().min(min).max(max));
const rangedInt = (min: number, max: number) => pyInt().pipe(z.number().min(min).max(max));

/** The goal; `water_ml` and `steps` stay undefined when they were not sent (a PUT without them keeps the saved value). */
export const goalIn = z.object({
  kcal: rangedInt(500, 10000), protein: ranged(0, 1000), carbs: ranged(0, 1000), fat: ranged(0, 1000),
  water_ml: rangedInt(500, 6000).optional(), steps: rangedInt(STEPS_GOAL_RANGE[0], STEPS_GOAL_RANGE[1]).optional(),
});

/** Body fat in percent: 0 < v < 1 is a fraction (x 100), then 2 to 75 % counts; rounded to 0.1 %. */
export const bodyFat = () => pyFloat().transform((v) => (v > 0 && v < 1 ? v * 100 : v))
  .refine((v) => v >= 2 && v <= 75, { message: 'Value error, body fat must be between 2 and 75 percent' })
  .transform((v) => roundHalfEven(v, 1));

/** Weight of a day; a body value that is sent (null clears it) is set, one that is left out stays as stored. */
export const weightIn = z.object({
  kg: ranged(20, 400),
  body_fat_pct: bodyFat().nullable().optional(),
  lean_kg: ranged(20, 300).nullable().optional(),
});

export const waterAdd = z.object({ add_ml: rangedInt(-2000, 2000) });
export const waterSet = z.object({ ml: rangedInt(0, 10000) });

const hours = () => nullish(ranged(8, 72));
export const fastStart = z.object({ started_at: nullish(pyInt()), target_hours: hours() });
export const fastStop = z.object({ ended_at: nullish(pyInt()) });
export const fastPatch = z.object({ started_at: nullish(pyInt()), ended_at: nullish(pyInt()), target_hours: hours() });

export const demoIn = z.object({ days: rangedInt(1, 365).default(30) });

export const badgesSeenIn = z.object({ codes: z.array(z.string()).max(100) });
