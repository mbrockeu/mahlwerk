// models.py: request bodies of routes/activity.py (activity of a day, workouts, the Health sync) as zod schemas.
import { z } from 'zod';
import * as rules from '../activity.ts';
import { bodyFat } from './body.ts';
import { nullish, pyBool, pyFloat, pyInt, pyStr } from './common.ts';

const ranged = (min: number, max: number) => pyFloat().pipe(z.number().min(min).max(max));
const rangedInt = (min: number, max: number) => pyInt().pipe(z.number().min(min).max(max));
const minutes = () => pyFloat().pipe(z.number().gt(0).max(rules.MAX_MINUTES));

/** Partial: only the fields that are sent change, `null` clears a value (absent keys stay absent in the parsed object). */
export const activityPut = z.object({
  steps: rangedInt(0, rules.MAX_STEPS).nullable().optional(),
  active_kcal: ranged(0, rules.MAX_ACTIVE_KCAL).nullable().optional(),
  distance_m: ranged(0, rules.MAX_DISTANCE_M).nullable().optional(),
});

export const workoutIn = z.object({
  day: pyStr(),
  kind: pyStr(0, 100),
  name: nullish(pyStr(0, 100)),
  minutes: minutes(),
  kcal: nullish(ranged(0, rules.MAX_WORKOUT_KCAL)),
  distance_m: nullish(ranged(0, rules.MAX_DISTANCE_M)),
  steps: nullish(rangedInt(0, rules.MAX_STEPS)),
  started_at: nullish(pyInt().pipe(z.number().min(0))),
  note: nullish(pyStr(0, 500)),
});

/** Partial: only the fields that are sent change; `null` clears kcal (back to the estimate), distance, steps, start and note. */
export const workoutPatch = z.object({
  day: pyStr().nullable().optional(),
  kind: pyStr(0, 100).nullable().optional(),
  name: pyStr(0, 100).nullable().optional(),
  minutes: minutes().nullable().optional(),
  kcal: ranged(0, rules.MAX_WORKOUT_KCAL).nullable().optional(),
  distance_m: ranged(0, rules.MAX_DISTANCE_M).nullable().optional(),
  steps: rangedInt(0, rules.MAX_STEPS).nullable().optional(),
  started_at: pyInt().pipe(z.number().min(0)).nullable().optional(),
  note: pyStr(0, 500).nullable().optional(),
});

const healthWorkout = z.object({
  external_id: pyStr(1, 100),
  kind: nullish(pyStr(0, 100)),
  name: nullish(pyStr(0, 100)),
  started_at: nullish(pyInt().pipe(z.number().min(0))),
  minutes: minutes(),
  kcal: nullish(ranged(0, rules.MAX_WORKOUT_KCAL)),
  distance_m: nullish(ranged(0, rules.MAX_DISTANCE_M)),
}).refine((w) => Boolean(w.kind || w.name), { message: 'Value error, kind or name is required' });

const healthDay = z.object({
  day: pyStr(),
  steps: nullish(rangedInt(0, rules.MAX_STEPS)),
  active_kcal: nullish(ranged(0, rules.MAX_ACTIVE_KCAL)),
  distance_m: nullish(ranged(0, rules.MAX_DISTANCE_M)),
  weight_kg: nullish(ranged(20, 400)),
  body_fat_pct: nullish(bodyFat()),
  lean_kg: nullish(ranged(20, 300)),
  water_ml: nullish(rangedInt(0, 10000)),
  sleep_minutes: nullish(rangedInt(0, 1440)),
  workouts: z.array(healthWorkout).max(50).default([]),
});

export const healthSync = z.object({ days: z.array(healthDay).max(400), overwrite_manual: pyBool().default(false) });
