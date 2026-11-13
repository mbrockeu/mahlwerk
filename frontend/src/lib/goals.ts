// Pure helpers for the goals page: macro arithmetic, presets and the energy-need estimate (Mifflin-St Jeor).
// No DOM, no framework: tested by tests/goals.test.mjs.

export const KCAL_LIMITS = { min: 500, max: 10000 } as const;
export const MACRO_LIMITS = { min: 0, max: 1000 } as const;
export const WATER_LIMITS = { min: 500, max: 6000 } as const;
export const STEPS_LIMITS = { min: 1000, max: 50000, step: 500 } as const;
/** The part of the calorie range the scale shows; typing reaches the rest. */
export const SCALE = { min: 1200, max: 4000, step: 50 } as const;
export const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 } as const;

export type MacroKey = 'protein' | 'carbs' | 'fat';
export interface Macros { protein: number; carbs: number; fat: number }

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const snap = (v: number, step: number) => Math.round(v / step) * step;

export const macroKcal = (m: Macros) => m.protein * KCAL_PER_G.protein + m.carbs * KCAL_PER_G.carbs + m.fat * KCAL_PER_G.fat;

/** Share of each macro in the energy of the macros, whole percent, adding up to 100 (largest remainder). */
export function macroShares(m: Macros): Macros {
  const total = macroKcal(m);
  if (total <= 0) return { protein: 0, carbs: 0, fat: 0 };
  const keys: MacroKey[] = ['protein', 'carbs', 'fat'];
  const raw = keys.map((k) => ((m[k] * KCAL_PER_G[k]) / total) * 100);
  const floor = raw.map(Math.floor);
  let rest = 100 - floor.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (rest <= 0) break; floor[i] += 1; rest -= 1; }
  return { protein: floor[0], carbs: floor[1], fat: floor[2] };
}

/** How far the macros are from the calorie goal. diff > 0: the macros add up to more than the goal. */
export function macroGap(kcal: number, m: Macros) {
  const total = macroKcal(m);
  const diff = Math.round(total - kcal);
  return { total: Math.round(total), diff, rel: kcal > 0 ? Math.abs(total - kcal) / kcal : 0 };
}

/** Carbohydrate grams that make the macros add up to the calorie goal; null if protein and fat alone are too much or it is out of range. */
export function alignCarbs(kcal: number, m: Macros): number | null {
  const g = Math.round((kcal - m.protein * KCAL_PER_G.protein - m.fat * KCAL_PER_G.fat) / KCAL_PER_G.carbs);
  return g < MACRO_LIMITS.min || g > MACRO_LIMITS.max ? null : g;
}

export type PresetId = 'balanced' | 'protein' | 'lowcarb';
/** Share of the calories: protein / carbohydrates / fat. */
export const PRESETS: { id: PresetId; shares: [number, number, number] }[] = [
  { id: 'balanced', shares: [20, 50, 30] },
  { id: 'protein', shares: [30, 40, 30] },
  { id: 'lowcarb', shares: [25, 30, 45] },
];

export function presetMacros(kcal: number, id: PresetId): Macros {
  const p = PRESETS.find((x) => x.id === id)!.shares;
  const g = (share: number, per: number) => clamp(Math.round((kcal * share) / 100 / per), MACRO_LIMITS.min, MACRO_LIMITS.max);
  return { protein: g(p[0], KCAL_PER_G.protein), carbs: g(p[1], KCAL_PER_G.carbs), fat: g(p[2], KCAL_PER_G.fat) };
}

/** The preset the grams correspond to (within 2 g each), if any. */
export function matchingPreset(kcal: number, m: Macros): PresetId | null {
  for (const { id } of PRESETS) {
    const want = presetMacros(kcal, id);
    if (Math.abs(want.protein - m.protein) <= 2 && Math.abs(want.carbs - m.carbs) <= 2 && Math.abs(want.fat - m.fat) <= 2) return id;
  }
  return null;
}

// ---- energy need ----

export type Sex = 'f' | 'm' | 'x';
export type Intent = 'keep' | 'lose' | 'gain';
export const ACTIVITY = [1.2, 1.375, 1.55, 1.725, 1.9] as const;
export const INTENT_DELTA: Record<Intent, number> = { keep: 0, lose: -300, gain: 300 };
export const MIN_SUGGESTION = 1200;
export const CALC_LIMITS = { age: [14, 110], height: [100, 230], weight: [30, 300] } as const;

export interface CalcInput { sex: Sex; age: number; height: number; weight: number; activity: number; intent: Intent }

const SEX_OFFSET: Record<Sex, number> = { m: 5, f: -161, x: (5 - 161) / 2 };

/** Basal metabolic rate in kcal/day (Mifflin-St Jeor). "x" uses the mean of both formulas. */
export const bmr = (i: Pick<CalcInput, 'sex' | 'age' | 'height' | 'weight'>) => 10 * i.weight + 6.25 * i.height - 5 * i.age + SEX_OFFSET[i.sex];

export function calcValid(i: Pick<CalcInput, 'age' | 'height' | 'weight'>): boolean {
  const inside = (v: number, [lo, hi]: readonly [number, number]) => Number.isFinite(v) && v >= lo && v <= hi;
  return inside(i.age, CALC_LIMITS.age) && inside(i.height, CALC_LIMITS.height) && inside(i.weight, CALC_LIMITS.weight);
}

/** Basal rate, total daily need and a suggested goal (rounded to 50, never below 1,200). */
export function suggest(i: CalcInput) {
  const base = bmr(i);
  const total = base * (ACTIVITY[i.activity] ?? ACTIVITY[0]);
  const target = clamp(snap(total + INTENT_DELTA[i.intent], 50), MIN_SUGGESTION, KCAL_LIMITS.max);
  return { bmr: Math.round(base), total: Math.round(total), target };
}
