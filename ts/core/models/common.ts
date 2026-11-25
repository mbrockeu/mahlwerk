// Building blocks that make zod validate like pydantic does for JSON bodies (lax mode): numbers may arrive as numeric
// strings, an int may be an integral float, a bool is no number, a str is never made from a number. Unknown keys are dropped.
import { z } from 'zod';

const NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const looseNumber = (v: unknown) => (typeof v === 'string' && NUMBER_TEXT.test(v.trim()) ? Number(v.trim()) : typeof v === 'boolean' ? Number(v) : v);

const TRUE = ['true', 't', 'yes', 'y', 'on', '1'];
const FALSE = ['false', 'f', 'no', 'n', 'off', '0'];
const looseBool = (v: unknown) => {
  if (typeof v === 'string') return TRUE.includes(v.trim().toLowerCase()) ? true : FALSE.includes(v.trim().toLowerCase()) ? false : v;
  return v === 1 ? true : v === 0 ? false : v;
};

/** pydantic `bool`: also 0/1 and the words true/false, yes/no, on/off, t/f, y/n, 1/0. */
export const pyBool = () => z.preprocess(looseBool, z.boolean());

/** pydantic `float` / `int` (a bool counts as 0/1 there). Constraints are added with the usual zod methods. */
export const pyFloat = () => z.preprocess(looseNumber, z.number());
export const pyInt = () => z.preprocess(looseNumber, z.number().int());

/** A string whose length counts code points like Python's len(). */
export const pyStr = (min = 0, max = Infinity) => z.string().refine((s) => [...s].length >= min, { message: `String should have at least ${min} characters` })
  .refine((s) => [...s].length <= max, { message: `String should have at most ${max} characters` });

/** `X | None = None`: a missing key and an explicit null both give null. */
export const nullish = <T extends z.ZodType>(schema: T) => schema.nullable().default(null);

export const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
export type Meal = (typeof MEALS)[number];
export const mealSchema = z.enum(MEALS);
export const unitSchema = z.enum(['g', 'ml']);
export type Unit = z.infer<typeof unitSchema>;
