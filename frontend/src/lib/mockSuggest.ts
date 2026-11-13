// The mock's counterpart of src/mahlwerk/suggest.py (same rule, same weights; see the module text there). Only bundled in the mock and the demo.
import type { SuggestFocus, SuggestReason } from './types';

export interface Rest { kcal: number | null; protein: number | null; carbs: number | null; fat: number | null }
export interface Candidate { id: number; kcal: number; protein: number | null; carbs: number | null; fat: number | null; portionAmount: number }
export interface Ranked { id: number; portions: number; amount: number; kcal: number; protein: number | null; carbs: number | null; fat: number | null; after: Rest; reasons: SuggestReason[]; score: number }

const FACTORS = [1, 0.5, 1.5, 2];
const WEIGHTS: Record<SuggestFocus, { fit: number; protein: number; variety: number; light: number }> = {
  balanced: { fit: 0.4, protein: 0.3, variety: 0.3, light: 0 }, protein: { fit: 0.25, protein: 0.55, variety: 0.2, light: 0 },
  light: { fit: 0.25, protein: 0, variety: 0.2, light: 0.55 }, rotation: { fit: 0.2, protein: 0.15, variety: 0.65, light: 0 },
};
const ORDER: Record<SuggestFocus, SuggestReason[]> = {
  balanced: ['fills_protein', 'not_eaten_lately', 'fits_kcal', 'high_protein', 'light', 'slightly_over'],
  protein: ['fills_protein', 'high_protein', 'fits_kcal', 'not_eaten_lately', 'slightly_over', 'light'],
  light: ['light', 'fits_kcal', 'not_eaten_lately', 'fills_protein', 'high_protein', 'slightly_over'],
  rotation: ['not_eaten_lately', 'fits_kcal', 'fills_protein', 'high_protein', 'light', 'slightly_over'],
};
const sub = (left: number | null, v: number | null) => (left == null || v == null ? null : Math.round((left - v) * 10) / 10);
const variety = (ds: number | null) => (ds == null ? 1 : Math.min(Math.max(ds, 0), 21) / 21);
const recency = (ds: number | null) => (ds != null && ds <= 1 ? 0.2 : ds === 2 ? 0.1 : 0);

function evaluate(c: Candidate, f: number, rest: Rest, ds: number | null, focus: SuggestFocus): { score: number; flags: SuggestReason[] } | null {
  const kcal = c.kcal * f;
  const protein = c.protein == null ? null : c.protein * f;
  let ratio: number | null = null;
  let fit: number | null = null;
  let slightlyOver = false;
  if (rest.kcal != null) {
    if (kcal > rest.kcal + Math.max(30, 0.05 * rest.kcal)) return null;
    ratio = rest.kcal > 0 ? kcal / rest.kcal : 2;
    if (ratio <= 1) fit = Math.max(0, 1 - Math.abs(ratio - 0.6) / 0.6); else { fit = 0.1; slightlyOver = true; }
  }
  let prot = 0;
  let flagProtein: SuggestReason | null = null;
  if (protein != null) {
    if (rest.protein != null && rest.protein > 0) {
      prot = Math.min(1, protein / rest.protein);
      if (prot >= 0.35 && protein >= 15) flagProtein = 'fills_protein';
    } else {
      const density = kcal > 0 ? (4 * protein) / kcal : 0;
      prot = Math.min(1, density / 0.4);
      if (density >= 0.25 && rest.protein == null) flagProtein = 'high_protein';
    }
  }
  const w = { ...WEIGHTS[focus] };
  if (fit == null) { w.variety += w.fit * 0.5; w.protein += w.fit * 0.5; w.fit = 0; fit = 0; }
  const light = 1 - Math.min(kcal, 800) / 800;
  let over = 0;
  for (const [value, left] of [[c.carbs, rest.carbs], [c.fat, rest.fat]] as const) if (value != null && left != null) over += 0.25 * Math.min(1, Math.max(0, value * f - Math.max(left, 0)) / 30);
  const score = Math.round((w.fit * fit + w.protein * prot + w.variety * variety(ds) + w.light * light - over - recency(ds)) * 1e6) / 1e6;
  const flags: SuggestReason[] = [];
  if (flagProtein) flags.push(flagProtein);
  if (ratio != null && ratio >= 0.25 && ratio <= 1) flags.push('fits_kcal');
  if (ds == null || ds >= 14) flags.push('not_eaten_lately');
  if (kcal <= 350) flags.push('light');
  if (slightlyOver) flags.push('slightly_over');
  return { score, flags };
}

export function rank(rest: Rest, candidates: Candidate[], daysSince: Map<number, number>, focus: SuggestFocus, limit: number, anyway: boolean): { state: 'ok' | 'goal_reached' | 'no_goal' | 'nothing_fits' | 'no_recipes'; items: Ranked[] } {
  const usable = candidates.filter((c) => c.kcal > 0 && c.portionAmount > 0);
  if (!usable.length) return { state: 'no_recipes', items: [] };
  const reached = rest.kcal != null && rest.kcal < 1;
  if (reached && !anyway) return { state: 'goal_reached', items: [] };
  const basis: Rest = reached ? { ...rest, kcal: null } : rest;
  const use: SuggestFocus = reached ? 'light' : focus;
  const out: Ranked[] = [];
  for (const c of [...usable].sort((a, b) => a.id - b.id)) {
    const ds = daysSince.get(c.id) ?? null;
    let best: { f: number; score: number; flags: SuggestReason[] } | null = null;
    const firstFit = reached || focus === 'light'; // one portion, a half only when one does not fit
    for (const f of firstFit ? [1, 0.5] : FACTORS) {
      if (reached && c.kcal * f > 300) continue;
      const s = evaluate(c, f, basis, ds, use);
      if (s && (best == null || (!firstFit && s.score > best.score))) best = { f, ...s };
    }
    if (!best) continue;
    const r1 = (v: number | null) => (v == null ? null : Math.round(v * best!.f * 10) / 10);
    const kcal = Math.round(c.kcal * best.f * 10) / 10;
    out.push({
      id: c.id, portions: best.f, amount: Math.round(c.portionAmount * best.f * 10) / 10, kcal, protein: r1(c.protein), carbs: r1(c.carbs), fat: r1(c.fat),
      after: { kcal: sub(rest.kcal, kcal), protein: sub(rest.protein, c.protein == null ? null : c.protein * best.f), carbs: sub(rest.carbs, c.carbs == null ? null : c.carbs * best.f), fat: sub(rest.fat, c.fat == null ? null : c.fat * best.f) },
      reasons: ORDER[use].filter((x) => best!.flags.includes(x)).slice(0, 2), score: best.score,
    });
  }
  if (!out.length) return { state: reached ? 'goal_reached' : 'nothing_fits', items: [] };
  out.sort((a, b) => b.score - a.score || a.id - b.id);
  return { state: reached ? 'goal_reached' : rest.kcal == null ? 'no_goal' : 'ok', items: out.slice(0, Math.max(1, limit)) };
}
