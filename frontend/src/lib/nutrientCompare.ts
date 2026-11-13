// Comparing several nutrients over time: the selection (in the URL), the shared percent scale and the numbers under the chart.
// No DOM, no framework: tested by tests/nutrients.test.mjs. Nothing here invents a reference amount: a nutrient without
// one (no NRV, no personal goal) can only be shown alone, in its own unit.

export const CORE_KEYS = ['kcal', 'protein', 'carbs', 'fat', 'sugars', 'fiber', 'salt', 'saturated_fat'] as const;
export const MAX_PICK = 4;
export const DEFAULT_PICK = 'fiber';
/** Below this share of the calories with a value a figure is probably too low (same limit as the rest of the app). */
export const LOW_COVERAGE = 0.2;

export interface Ref { value: number; kind: 'goal' | 'nrv' }
export interface GoalLike { kcal: number; protein: number; carbs: number; fat: number }
export type RefOf = (key: string) => Ref | null;

const KEY = /^[a-z][a-z0-9_]{0,40}$/;

/** Keys from `?nut=a,b,c`: valid, known (when the directory is loaded), no duplicates, at most four, order kept. */
export function parsePick(raw: string | null | undefined, known?: ReadonlySet<string> | null): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const k = part.trim();
    if (!KEY.test(k) || out.includes(k)) continue;
    if (known && !known.has(k)) continue;
    out.push(k);
    if (out.length === MAX_PICK) break;
  }
  return out;
}
export const pickParam = (sel: string[]) => sel.join(',');

/** Reference amount of a nutrient: the personal goal for kcal, protein, carbs and fat, else the EU reference intake. */
export function refOf(key: string, goal: GoalLike | null | undefined, nrv: number | null | undefined): Ref | null {
  if (key === 'kcal' || key === 'protein' || key === 'carbs' || key === 'fat') {
    const g = goal?.[key];
    return g != null && g > 0 ? { value: g, kind: 'goal' } : null;
  }
  return nrv != null && nrv > 0 ? { value: nrv, kind: 'nrv' } : null;
}

/** The selection as the page uses it: empty falls back to the default; several nutrients keep only those with a reference
 *  (a link with a mix is repaired, not refused); never empty. */
export function normalizePick(sel: string[], ref: RefOf): string[] {
  const list = sel.length ? sel : [DEFAULT_PICK];
  if (list.length < 2) return list;
  const withRef = list.filter((k) => ref(k));
  return withRef.length ? withRef : [list[0]];
}

export type Blocked = 'max' | 'noref' | 'last' | null;
/** Why a row of the picker cannot be switched: the limit, no reference while others are shown, or it is the last one. */
export function blockedReason(sel: string[], key: string, ref: RefOf): Blocked {
  if (sel.includes(key)) return sel.length === 1 ? 'last' : null;
  if (!ref(key) && sel.some((k) => ref(k))) return 'noref';
  if (sel.length >= MAX_PICK) return 'max';
  return null;
}
/** Switch one nutrient on or off. Choosing a nutrient with a reference while a lone one without is shown replaces that one;
 *  choosing one without a reference while others are shown does nothing (the row is disabled). */
export function togglePick(sel: string[], key: string, ref: RefOf): string[] {
  if (sel.includes(key)) return sel.length === 1 ? sel : sel.filter((k) => k !== key);
  if (!ref(key)) return sel.some((k) => ref(k)) ? sel : [key];
  const kept = sel.filter((k) => ref(k));
  return kept.length >= MAX_PICK ? sel : [...kept, key];
}

export type PickGroup = 'macro' | 'vitamin' | 'mineral' | 'other';
export interface PickItem { key: string; name: string; group: PickGroup; unit: string; ref: Ref | null }
export const PICK_GROUPS: PickGroup[] = ['macro', 'vitamin', 'mineral', 'other'];
export function pickGroup(key: string, group: string): PickGroup {
  if ((CORE_KEYS as readonly string[]).includes(key) || group === 'core') return 'macro';
  return group === 'vitamin' || group === 'mineral' ? group : 'other';
}

export interface Section { start: string; end: string; average: number | null; coverage: number }
export interface Pt { value: number | null; pct: number | null; coverage: number; known: boolean; low: boolean }
/** A section has a value when there is a mean and at least some calories carry it; otherwise it is a gap, never a zero. */
export const isKnown = (p: Section) => p.average != null && p.coverage > 0;
export function pointsOf(series: Section[], ref: Ref | null): Pt[] {
  return series.map((p) => {
    const known = isKnown(p);
    const value = known ? (p.average as number) : null;
    return { value, pct: value != null && ref ? (value / ref.value) * 100 : null, coverage: p.coverage, known, low: known && p.coverage < LOW_COVERAGE };
  });
}

/** Top of a value axis: 1, 2, 2.5, 5 or 10 times a power of ten that holds `top`. */
export function niceMax(top: number): number {
  const t = Math.max(top, 1e-6);
  const mag = 10 ** Math.floor(Math.log10(t));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((c) => c >= t - 1e-9) ?? t;
}
/** Top of the shared percent axis: holds the highest point and the 100 % line with some air above it. */
export const percentMax = (maxPct: number) => niceMax(Math.max(maxPct, 100) * 1.1);

/** Move end labels apart so that neighbours keep `gap` pixels, inside [min, max]; keeps the order of the input positions. */
export function spreadLabels(ys: number[], gap: number, min: number, max: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y || a.i - b.i);
  const out = order.map((o) => Math.min(Math.max(o.y, min), max));
  for (let k = 1; k < out.length; k += 1) out[k] = Math.max(out[k], out[k - 1] + gap);
  const over = out.length ? out[out.length - 1] - max : 0;
  if (over > 0) {
    out[out.length - 1] -= over;
    for (let k = out.length - 2; k >= 0; k -= 1) out[k] = Math.min(out[k], out[k + 1] - gap);
  }
  const res = new Array<number>(ys.length);
  order.forEach((o, k) => { res[o.i] = out[k]; });
  return res;
}

/** Marker every n-th point so that markers keep about `min` pixels between them. */
export const markerStride = (step: number, min = 14) => Math.max(1, Math.ceil(min / Math.max(step, 1)));

export interface MicroLike { key: string; average: number; coverage: number }
export interface Summary { mean: number | null; coverage: number | null; pct: number | null; low: boolean; fromRange: boolean }
/** Mean per logged day over the range and how many calories carry it. Prefers the exact figures of the range (the `micros`
 *  and `averages` of the evaluation); without them the mean of the sections with a value. */
export function summaryOf(key: string, series: Section[], ref: Ref | null, micros: MicroLike[], averages: Record<string, number> | null): Summary {
  let mean: number | null = null;
  let coverage: number | null = null;
  let fromRange = false;
  const m = micros.find((x) => x.key === key);
  if (m) { mean = m.average; coverage = m.coverage; fromRange = true; }
  else if ((CORE_KEYS as readonly string[]).includes(key) && averages && averages[key] != null && series.some(isKnown)) { mean = averages[key]; coverage = 1; fromRange = true; }
  else {
    const known = series.filter(isKnown);
    if (known.length) {
      mean = known.reduce((s, p) => s + (p.average as number), 0) / known.length;
      coverage = known.reduce((s, p) => s + p.coverage, 0) / known.length;
    }
  }
  return { mean, coverage, pct: mean != null && ref ? (mean / ref.value) * 100 : null, low: coverage != null && coverage < LOW_COVERAGE, fromRange };
}

export type Shape = 'circle' | 'square' | 'triangle' | 'diamond';
/** How the four lines differ besides colour: dash pattern and marker shape (colours are tokens of app.css). */
export const SERIES_STYLES: { color: string; dash: string | undefined; shape: Shape }[] = [
  { color: 'var(--bar)', dash: undefined, shape: 'circle' },
  { color: 'var(--warn)', dash: '11 5', shape: 'square' },
  { color: 'var(--bar-over)', dash: '1 6', shape: 'triangle' },
  { color: 'var(--text)', dash: '12 4 2 4', shape: 'diamond' },
];
/** Path of a marker of radius r around (x, y). */
export function markerPath(shape: Shape, x: number, y: number, r: number): string {
  const f = (v: number) => v.toFixed(1);
  if (shape === 'square') return `M${f(x - r)} ${f(y - r)}h${f(2 * r)}v${f(2 * r)}h${f(-2 * r)}z`;
  if (shape === 'triangle') return `M${f(x)} ${f(y - r * 1.15)}L${f(x + r * 1.1)} ${f(y + r * 0.85)}H${f(x - r * 1.1)}z`;
  if (shape === 'diamond') return `M${f(x)} ${f(y - r * 1.25)}L${f(x + r * 1.25)} ${f(y)}L${f(x)} ${f(y + r * 1.25)}L${f(x - r * 1.25)} ${f(y)}z`;
  return `M${f(x - r)} ${f(y)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0z`;
}
