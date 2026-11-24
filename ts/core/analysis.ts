// Long-range analysis on top of the daily totals (analysis.py): series per day/week/month, comparison with the period
// before, calendar states, nutrient curves and the estimated real energy expenditure. Pure functions of loaded data.
import { addDays, daysBetween, weekday } from './dates.ts';
import { isoWeek, monthDays } from './calendar.ts';
import { kcalOn, type Timeline, goalOn } from './goals.ts';
import * as nutrients from './nutrients.ts';
import { scale } from './nutrition.ts';
import { pySum, roundHalfEven } from './num.ts';

export type Granularity = 'day' | 'week' | 'month';
export const GRANULARITIES: readonly string[] = ['day', 'week', 'month'];
export const DAY_LIMIT = 45; // auto: single days up to this many days
export const WEEK_LIMIT = 370; // auto: weeks up to this many days, months beyond
export const DETAIL_DAYS = 370; // `days` and `calendar` are only delivered up to this many days
export const SERIES_KEYS = ['kcal', 'protein', 'carbs', 'fat', 'sugars', 'fiber', 'salt', 'saturated_fat'] as const;
const RANGE_LOW = 0.9, RANGE_HIGH = 1.1, EPS = 1e-9; // the 90-110 % band

const KCAL_PER_KG = 7700.0;
const EXP_MIN_DAYS = 21;
const EXP_MIN_LOGGED_SHARE = 0.70;
const EXP_MIN_WEIGHTS = 6;
const EXP_MIN_WEIGHT_SPREAD = 14;
const EXP_MIN_MARGIN = 0.10;
const KCAL_PER_KG_FAT = 9400.0;
const KCAL_PER_KG_LEAN = 1800.0;
const COMP_MIN_POINTS = 4;
const COMP_MIN_SPREAD = 14;
const RATE_MIN_POINTS = 4;
const RATE_MIN_SPREAD = 10;

export type Totals = Record<string, Record<string, number>>;
/** A weight row as `weightsBetween` returns it: the body values are missing where the day has none. */
export interface WeightRow { day: string; kg: number; body_fat_pct?: number | null; lean_kg?: number | null }

/** round(value + 0.0, digits): the "+ 0.0" turns -0.0 into 0.0. */
export const r = (value: number, digits = 1): number => roundHalfEven(value + 0.0, digits);

export const mean = (values: Iterable<number>): number => {
  const list = [...values];
  return list.length ? pySum(list) / list.length : 0.0;
};

export function adherenceClass(kcal: number, goalKcal: number): 'in' | 'over' | 'under' {
  if (kcal > goalKcal * RANGE_HIGH + EPS) return 'over';
  if (kcal < goalKcal * RANGE_LOW - EPS) return 'under';
  return 'in';
}

/** `auto` picks days up to 45 days, weeks up to 370 days, otherwise months; explicit values are kept. */
export function resolveGranularity(granularity: string, nDays: number): Granularity {
  if (GRANULARITIES.includes(granularity)) return granularity as Granularity;
  if (nDays <= DAY_LIMIT) return 'day';
  return nDays <= WEEK_LIMIT ? 'week' : 'month';
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const max = (a: string, b: string) => (a > b ? a : b);
const min = (a: string, b: string) => (a < b ? a : b);

/** Sections [start, end, label] covering first..last, clipped to it. Weeks are ISO weeks, months calendar months. */
export function buckets(first: string, last: string, granularity: string): [string, string, string][] {
  const out: [string, string, string][] = [];
  if (granularity === 'day') {
    for (let d = first; d <= last; d = addDays(d, 1)) out.push([d, d, d]);
  } else if (granularity === 'week') {
    for (let monday = addDays(first, -weekday(first)); monday <= last; monday = addDays(monday, 7)) {
      const [year, week] = isoWeek(monday);
      out.push([max(monday, first), min(addDays(monday, 6), last), `${year}-W${pad2(week)}`]);
    }
  } else {
    let year = Number(first.slice(0, 4));
    let month = Number(first.slice(5, 7));
    const date = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
    while (date(year, month, 1) <= last) {
      out.push([max(date(year, month, 1), first), min(date(year, month, monthDays(year, month)), last), `${year}-${pad2(month)}`]);
      [year, month] = month === 12 ? [year + 1, 1] : [year, month + 1];
    }
  }
  return out;
}

export const monthKeys = (first: string, last: string): string[] => buckets(first, last, 'month').map((b) => b[2]);

const daysOfBucket = (start: string, end: string): string[] => Array.from({ length: daysBetween(start, end) + 1 }, (_, i) => addDays(start, i));

export interface ActivityRow { steps: number | null; active_kcal: number | null }

/** One item per section: means per logged day (nutrients), per day with a value (water, weight, steps, active energy), the
 * workout minutes, the mean goal and the adherence counts. */
export function buildSeries(
  first: string, last: string, granularity: string, totals: Totals, logged: Set<string>, water: Record<string, number>,
  weightByDay: Record<string, number>, tl: Timeline | null, bonus: Record<string, number> = {},
  activity: Record<string, ActivityRow> = {}, workoutMinutes: Record<string, number> = {},
): Record<string, any>[] {
  const has = (o: object, k: string) => Object.hasOwn(o, k);
  const result = [];
  for (const [start, end, label] of buckets(first, last, granularity)) {
    const days = daysOfBucket(start, end);
    const got = days.filter((d) => logged.has(d));
    const item: Record<string, any> = { start, end, label_key: label, logged_days: got.length, days: days.length };
    for (const key of SERIES_KEYS) item[key] = r(mean(got.map((d) => totals[d][key])));
    const waters = days.filter((d) => has(water, d)).map((d) => water[d]);
    const weights = days.filter((d) => has(weightByDay, d)).map((d) => weightByDay[d]);
    item.water_ml = waters.length ? roundHalfEven(mean(waters)) : null;
    item.weight = weights.length ? r(mean(weights), 2) : null;
    const steps = days.filter((d) => has(activity, d) && activity[d].steps !== null).map((d) => activity[d].steps!);
    const energy = days.filter((d) => has(activity, d) && activity[d].active_kcal !== null).map((d) => activity[d].active_kcal!);
    item.steps = steps.length ? roundHalfEven(mean(steps)) : null;
    item.active_kcal = energy.length ? roundHalfEven(mean(energy)) : null;
    item.workout_minutes = r(pySum(days.map((d) => workoutMinutes[d] ?? 0)));
    item.goal_kcal = tl && got.length ? r(mean(got.map((d) => kcalOn(tl, bonus, d)!)))
      : tl ? goalOn(tl, days.at(-1)!).kcal : null;
    const counts = { in: 0, over: 0, under: 0 };
    if (tl) for (const d of got) counts[adherenceClass(totals[d].kcal, kcalOn(tl, bonus, d)!)]++;
    Object.assign(item, { in_range_days: counts.in, over_days: counts.over, under_days: counts.under });
    result.push(item);
  }
  return result;
}

/** State per day for a heat map: none, no_goal, under, in_range or over (against that day's goal). */
export function buildCalendar(dayKeys: string[], totals: Totals, logged: Set<string>, tl: Timeline | null, bonus: Record<string, number> = {}) {
  const states = { in: 'in_range', over: 'over', under: 'under' } as const;
  return dayKeys.map((day) => ({
    day,
    state: !logged.has(day) ? 'none' : !tl ? 'no_goal' : states[adherenceClass(totals[day].kcal, kcalOn(tl, bonus, day)!)],
  }));
}

// comparison ---------------------------------------------------------------------------------------------------------

/** Absolute and percentage difference; the percentage is null when the earlier value is 0. */
export function delta(current: number | null | undefined, previous: number | null | undefined) {
  if (current == null || previous == null) return null;
  const diff = current - previous;
  return { abs: r(diff, 2), pct: previous ? r((diff / previous) * 100, 1) : null };
}

/** The `previous` block and `deltas` from two light results of `compute`. deltas is null without logged days on a side. */
export function compareBlocks(current: Record<string, any>, previous: Record<string, any>): [Record<string, any>, Record<string, any> | null] {
  const block: Record<string, any> = {
    range: previous.range, averages: previous.averages, adherence: previous.adherence, weight: previous.weight,
    logged_days: previous.range.logged_days,
  };
  if (previous.range.logged_days === 0 || current.range.logged_days === 0) return [block, null];
  const share = (res: Record<string, any>): number | null => {
    const adh = res.adherence;
    const n = res.range.logged_days;
    return adh && n ? (adh.in_range_days / n) * 100 : null;
  };
  const cur = current.averages, prev = previous.averages;
  const deltas: Record<string, any> = {};
  for (const k of ['kcal', 'protein', 'carbs', 'fat', 'sugars', 'fiber', 'salt', 'water_ml', 'steps', 'active_kcal', 'workout_minutes']) deltas[k] = delta(cur[k], prev[k]);
  const cw = current.weight, pw = previous.weight;
  deltas.weight_change = cw && pw ? delta(cw.change, pw.change) : null;
  const cs = share(current), ps = share(previous);
  deltas.in_range_share = cs === null || ps === null ? null : { abs: r(cs - ps, 1), pct: null };
  return [block, deltas];
}

// body composition --------------------------------------------------------------------------------------------------

/** Least-squares slope of y on x and its standard error (0 with fewer than 3 points). */
function regress(points: [number, number][]): [number, number] {
  const n = points.length;
  const mx = pySum(points.map((p) => p[0])) / n, my = pySum(points.map((p) => p[1])) / n;
  const sxx = pySum(points.map(([x]) => (x - mx) * (x - mx)));
  const slope = pySum(points.map(([x, y]) => (x - mx) * (y - my))) / sxx;
  const intercept = my - slope * mx;
  const resid = pySum(points.map(([x, y]) => (y - (intercept + slope * x)) * (y - (intercept + slope * x))));
  return [slope, n > 2 ? Math.sqrt(resid / (n - 2) / sxx) : 0.0];
}

/** Body fat in percent of a weight row: the measured value, else derived from the lean mass (null without both). */
export function fatPct(w: WeightRow): number | null {
  if (w.body_fat_pct != null) return w.body_fat_pct;
  if (w.lean_kg != null && w.kg > 0) return Math.min(Math.max((1 - w.lean_kg / w.kg) * 100, 0.0), 100.0);
  return null;
}

export type BodyPoint = [number, number, number]; // day offset, fat kg, lean kg

/** (day offset from `first`, fat kg, lean kg) for every weight row with body composition. */
export function bodyPoints(weights: WeightRow[], first: string): BodyPoint[] {
  const out: BodyPoint[] = [];
  for (const w of [...weights].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))) {
    const pct = fatPct(w);
    if (pct !== null) {
      const fat = (w.kg * pct) / 100;
      out.push([daysBetween(first, w.day), fat, w.kg - fat]);
    }
  }
  return out;
}

const spread = (xs: number[]): number => Math.max(...xs) - Math.min(...xs);

/** What the weight change is made of: change of fat and lean mass from the least-squares lines, or null and the reasons. */
export function composition(points: BodyPoint[]): [Record<string, any> | null, string[]] {
  const missing: string[] = [];
  if (points.length < COMP_MIN_POINTS) missing.push('few_body_values');
  if (points.length < 2 || spread(points.map((p) => p[0])) < COMP_MIN_SPREAD) missing.push('body_not_spread');
  if (missing.length) return [null, missing];
  const span = spread(points.map((p) => p[0]));
  const [fatSlope] = regress(points.map(([x, f]) => [x, f]));
  const [leanSlope] = regress(points.map(([x, , m]) => [x, m]));
  return [{
    fat_change_kg: r(fatSlope * span, 2), lean_change_kg: r(leanSlope * span, 2),
    fat_kg_per_week: r(fatSlope * 7, 2), lean_kg_per_week: r(leanSlope * 7, 2), days: span, measurements: points.length,
  }, []];
}

/** Speed of the weight change per week from the least-squares line (needs 4 weights over 10 days), negative = losing. */
export function weightRate(weights: [number, number][]) {
  if (weights.length < RATE_MIN_POINTS || spread(weights.map((w) => w[0])) < RATE_MIN_SPREAD) return null;
  const [slope] = regress(weights);
  const m = mean(weights.map((w) => w[1]));
  return { kg_per_week: r(slope * 7, 2), pct_per_week: m ? r(((slope * 7) / m) * 100, 2) : 0.0, weigh_ins: weights.length };
}

/** Estimated real daily energy expenditure from mean intake and the weight trend (see analysis.py for the method). */
export function estimateExpenditure(
  nDays: number, loggedDays: number, intake: number, weights: [number, number][], goalKcal: number | null = null, body: BodyPoint[] | null = null,
): [Record<string, any> | null, string[]] {
  const missing: string[] = [];
  if (nDays < EXP_MIN_DAYS) missing.push('short_period');
  if (nDays && loggedDays / nDays < EXP_MIN_LOGGED_SHARE) missing.push('few_logged_days');
  if (weights.length < EXP_MIN_WEIGHTS) missing.push('few_weights');
  if (weights.length < 2 || spread(weights.map((w) => w[0])) < EXP_MIN_WEIGHT_SPREAD) missing.push('weights_not_spread');
  if (missing.length) return [null, missing];
  const n = weights.length;
  const [slope, se] = regress(weights);
  let stored = slope * KCAL_PER_KG, storedSe = se * KCAL_PER_KG, method = 'rule';
  if (body && composition(body)[0]) {
    [stored, storedSe] = regress(body.map(([x, f, m]): [number, number] => [x, f * KCAL_PER_KG_FAT + m * KCAL_PER_KG_LEAN]));
    method = 'composition';
  }
  const kcal = intake - stored;
  const half = Math.max(2 * storedSe, EXP_MIN_MARGIN * Math.abs(kcal));
  return [{
    kcal: roundHalfEven(kcal), low: roundHalfEven(kcal - half), high: roundHalfEven(kcal + half), intake: roundHalfEven(intake),
    weight_change_kg: r(slope * nDays, 2), kg_per_week: r(slope * 7, 2), days: nDays, weigh_ins: n,
    goal_gap: goalKcal ? roundHalfEven(goalKcal - kcal) : null, method,
  }, []];
}

// nutrient curve ------------------------------------------------------------------------------------------------------

const CORE_UNITS: Record<string, string> = { kcal: 'kcal', protein: 'g', carbs: 'g', fat: 'g', sugars: 'g', fiber: 'g', salt: 'g', saturated_fat: 'g' };
export const CORE_GOAL = ['kcal', 'protein', 'carbs', 'fat'];

/** {unit, nrv, group} of a core value or a directory nutrient; null for an unknown key. */
export function nutrientInfo(key: string): { unit: string; nrv: number | null; group: string } | null {
  if (Object.hasOwn(CORE_UNITS, key)) return { unit: CORE_UNITS[key], nrv: null, group: 'core' };
  const info = nutrients.BY_KEY.get(key);
  return info ? { unit: info.unit, nrv: info.nrv, group: info.group } : null;
}

interface CurveRow { day: string; amount: number; per_100: Parameters<typeof scale>[0]; extra?: Record<string, number> | null }

/** Curve of one nutrient: per section the mean per logged day and the coverage (see analysis.py). */
export function nutrientSeries(rows: CurveRow[], key: string, first: string, last: string, granularity: string) {
  const core = Object.hasOwn(CORE_UNITS, key);
  const perDay = new Map<string, number[]>(); // day -> [sum, kcal, known_kcal, entries, known_entries]
  for (const row of rows) {
    const values = scale(row.per_100, row.amount) as Record<string, number | null>;
    const kcal = values.kcal || 0.0;
    let value: number | null;
    if (core) value = values[key];
    else {
      const extra = row.extra || {};
      value = Object.hasOwn(extra, key) ? (extra[key] * row.amount) / 100 : null;
    }
    let slot = perDay.get(row.day);
    if (!slot) perDay.set(row.day, (slot = [0.0, 0.0, 0.0, 0, 0]));
    slot[1] += kcal;
    slot[3] += 1;
    if (value !== null) {
      slot[0] += value;
      slot[2] += kcal;
      slot[4] += 1;
    }
  }
  return buckets(first, last, granularity).map(([start, end]) => {
    const days = daysOfBucket(start, end).filter((d) => perDay.has(d)).map((d) => perDay.get(d)!);
    const total = pySum(days.map((s) => s[0]));
    const kcal = pySum(days.map((s) => s[1])), known = pySum(days.map((s) => s[2]));
    const n = pySum(days.map((s) => s[3])), nKnown = pySum(days.map((s) => s[4]));
    const coverage = kcal > 0 ? known / kcal : n ? nKnown / n : 0.0;
    return { start, end, average: days.length ? r(total / days.length, 3) : null, coverage: roundHalfEven(Math.min(1.0, coverage), 3) };
  });
}
