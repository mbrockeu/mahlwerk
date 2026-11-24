// "What still fits today": which recipes suit the rest of the day (suggest.py). A pure function, no storage, no network, no clock.
//
// Input: what is left of the day (`Rest`), the recipes as values per portion (`Candidate`), when each was last eaten (days ago, null = never)
// and a focus. Output: a ranking with the best amount (a half, one, one and a half or two portions) and one or two reason codes per recipe.
// Deterministic: the same input gives the same order (ties go to the lower food id). The rule is written out in suggest.py.
import type { Focus } from './models/recipe.ts';
import { roundHalfEven } from './num.ts';

const FACTORS = [1.0, 0.5, 1.5, 2.0]; // tried in this order; a later one must be strictly better to win
const OVER_TOLERANCE = 0.05;
const OVER_MIN = 30.0;
const IDEAL_SHARE = 0.6;
const LONG_AGO = 21;
const NOT_LATELY = 14;
const LIGHT_KCAL = 350.0;
const LIGHT_REFERENCE = 800.0;
const ANYWAY_MAX_KCAL = 300.0;
const PROTEIN_FULL_DENSITY = 0.4;
const FILLS_PROTEIN_SHARE = 0.35;
const FILLS_PROTEIN_MIN_G = 15.0;
const HIGH_PROTEIN_DENSITY = 0.25;

type Weights = { fit: number; protein: number; variety: number; light: number };
const WEIGHTS: Record<Focus, Weights> = {
  balanced: { fit: 0.40, protein: 0.30, variety: 0.30, light: 0.0 },
  protein: { fit: 0.25, protein: 0.55, variety: 0.20, light: 0.0 },
  light: { fit: 0.25, protein: 0.0, variety: 0.20, light: 0.55 },
  rotation: { fit: 0.20, protein: 0.15, variety: 0.65, light: 0.0 },
};
const REASON_ORDER: Record<Focus, string[]> = {
  balanced: ['fills_protein', 'not_eaten_lately', 'fits_kcal', 'high_protein', 'light', 'slightly_over'],
  protein: ['fills_protein', 'high_protein', 'fits_kcal', 'not_eaten_lately', 'slightly_over', 'light'],
  light: ['light', 'fits_kcal', 'not_eaten_lately', 'fills_protein', 'high_protein', 'slightly_over'],
  rotation: ['not_eaten_lately', 'fits_kcal', 'fills_protein', 'high_protein', 'light', 'slightly_over'],
};

/** What is left of the day; null = no goal for it (so nothing is known). */
export interface Rest { kcal: number | null; protein: number | null; carbs: number | null; fat: number | null }
export const rest = (kcal: number | null, protein: number | null = null, carbs: number | null = null, fat: number | null = null): Rest => ({ kcal, protein, carbs, fat });

/** A recipe as the values of ONE portion. `portion_amount` is how much of the food one portion is (g or ml). */
export interface Candidate { food_id: number; kcal: number | null; protein: number | null; carbs: number | null; fat: number | null; portion_amount: number }

export interface Suggestion {
  food_id: number; portions: number; amount: number; kcal: number; protein: number | null; carbs: number | null; fat: number | null;
  after: Rest; reasons: string[]; score: number;
}
export interface Result { state: string; items: Suggestion[]; eligible: number }

const r1 = (x: number) => roundHalfEven(x, 1);
const sub = (left: number | null, v: number | null): number | null => (left === null || v === null ? null : r1(left - v));
const variety = (d: number | null): number => (d === null ? 1.0 : Math.min(Math.max(d, 0), LONG_AGO) / LONG_AGO);
const recencyPenalty = (d: number | null): number => (d !== null && d <= 1 ? 0.2 : d === 2 ? 0.1 : 0.0);

/** [score, flags] of this amount, or null when it goes beyond the rest of the day. */
function evaluate(c: Candidate, factor: number, left: Rest, daysSince: number | null, focus: Focus): [number, string[]] | null {
  const kcal = c.kcal! * factor;
  const protein = c.protein === null ? null : c.protein * factor;
  let ratio: number | null = null;
  let fit: number | null = null;
  let slightlyOver = false;
  if (left.kcal !== null) {
    if (kcal > left.kcal + Math.max(OVER_MIN, OVER_TOLERANCE * left.kcal)) return null;
    ratio = left.kcal > 0 ? kcal / left.kcal : 2.0;
    if (ratio <= 1.0) fit = Math.max(0.0, 1.0 - Math.abs(ratio - IDEAL_SHARE) / IDEAL_SHARE);
    else { fit = 0.1; slightlyOver = true; }
  }
  let prot: number;
  let flagProtein: string | null;
  if (protein === null) { prot = 0.0; flagProtein = null; }
  else if (left.protein !== null && left.protein > 0) {
    const share = Math.min(1.0, protein / left.protein);
    prot = share;
    flagProtein = share >= FILLS_PROTEIN_SHARE && protein >= FILLS_PROTEIN_MIN_G ? 'fills_protein' : null;
  } else {
    const density = kcal > 0 ? (4 * protein) / kcal : 0.0;
    prot = Math.min(1.0, density / PROTEIN_FULL_DENSITY);
    flagProtein = density >= HIGH_PROTEIN_DENSITY && left.protein === null ? 'high_protein' : null;
  }
  const weights = { ...WEIGHTS[focus] };
  if (fit === null) { // no energy goal: the weight of fit goes to variety and protein
    const extra = weights.fit;
    weights.fit = 0.0;
    fit = 0.0;
    weights.variety += extra * 0.5;
    weights.protein += extra * 0.5;
  }
  const light = 1.0 - Math.min(kcal, LIGHT_REFERENCE) / LIGHT_REFERENCE;
  let over = 0.0;
  for (const [v, rem] of [[c.carbs, left.carbs], [c.fat, left.fat]] as const) {
    if (v !== null && rem !== null) over += 0.25 * Math.min(1.0, Math.max(0.0, v * factor - Math.max(rem, 0.0)) / 30.0);
  }
  const score = weights.fit * fit + weights.protein * prot + weights.variety * variety(daysSince) + weights.light * light - over - recencyPenalty(daysSince);
  const flags: string[] = [];
  if (flagProtein) flags.push(flagProtein);
  if (ratio !== null && 0.25 <= ratio && ratio <= 1.0) flags.push('fits_kcal');
  if (daysSince === null || daysSince >= NOT_LATELY) flags.push('not_eaten_lately');
  if (kcal <= LIGHT_KCAL) flags.push('light');
  if (slightlyOver) flags.push('slightly_over');
  return [roundHalfEven(score, 6), flags];
}

const reasons = (flags: string[], focus: Focus): string[] => REASON_ORDER[focus].filter((code) => flags.includes(code)).slice(0, 2);

/** The suggestions for the rest of the day, best first (see suggest.py for the rule). */
export function rank(left: Rest, candidates: Candidate[], daysSince: Map<number, number | null>, focus: Focus = 'balanced', limit = 5, anyway = false): Result {
  const usable = candidates.filter((c) => c.kcal !== null && c.kcal > 0 && c.portion_amount > 0);
  if (!usable.length) return { state: 'no_recipes', items: [], eligible: 0 };
  const reached = left.kcal !== null && left.kcal < 1;
  if (reached && !anyway) return { state: 'goal_reached', items: [], eligible: 0 };
  // asked for light ideas after the goal: no energy fit exists any more (there is nothing left to fit), only lightness
  const basis = reached ? rest(null, left.protein, left.carbs, left.fat) : left;
  const ranked: [number, number, Suggestion][] = [];
  for (const c of [...usable].sort((a, b) => a.food_id - b.food_id)) {
    const ds = daysSince.get(c.food_id) ?? null;
    let best: [number, [number, string[]]] | null = null;
    // "light" ranks recipes by what one portion weighs; the amount is one portion, a half only when one does not fit
    const firstFit = reached || focus === 'light';
    for (const factor of firstFit ? [1.0, 0.5] : FACTORS) {
      if (reached && c.kcal! * factor > ANYWAY_MAX_KCAL) continue;
      const scored = evaluate(c, factor, basis, ds, reached ? 'light' : focus);
      if (scored !== null && (best === null || (!firstFit && scored[0] > best[1][0]))) best = [factor, scored];
    }
    if (best === null) continue;
    const [factor, [score, flags]] = best;
    const kcal = r1(c.kcal! * factor);
    const part = (v: number | null) => (v === null ? null : v * factor);
    ranked.push([-score, c.food_id, {
      food_id: c.food_id, portions: factor, amount: r1(c.portion_amount * factor), kcal,
      protein: c.protein === null ? null : r1(c.protein * factor), carbs: c.carbs === null ? null : r1(c.carbs * factor), fat: c.fat === null ? null : r1(c.fat * factor),
      after: rest(sub(left.kcal, kcal), sub(left.protein, part(c.protein)), sub(left.carbs, part(c.carbs)), sub(left.fat, part(c.fat))),
      reasons: reasons(flags, reached ? 'light' : focus), score,
    }]);
  }
  ranked.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (!ranked.length) return { state: reached ? 'goal_reached' : 'nothing_fits', items: [], eligible: 0 };
  return { state: reached ? 'goal_reached' : left.kcal === null ? 'no_goal' : 'ok', items: ranked.slice(0, Math.max(1, limit)).map((t) => t[2]), eligible: ranked.length };
}
