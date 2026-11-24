// Evaluation of a date range (insights.py): totals, averages, distributions, top foods, weight trend and hints. Everything is
// a pure function of the entries, weights and goal passed in.
import * as activityRules from './activity.ts';
import * as analysis from './analysis.ts';
import { r, mean, type ActivityRow, type Totals, type WeightRow } from './analysis.ts';
import { addDays, daysBetween, toOrdinal, weekday } from './dates.ts';
import { asTimeline, current, goalOn, kcalOn, period as goalPeriod, type GoalValues, type Timeline } from './goals.ts';
import { MEALS } from './models/common.ts';
import * as nutrients from './nutrients.ts';
import { scale, type Per100 } from './nutrition.ts';
import { pySum, roundHalfEven } from './num.ts';

const NUTRIENT_KEYS = ['kcal', 'protein', 'carbs', 'fat', 'sugars', 'fiber', 'salt', 'saturated_fat'] as const;
const TOP_METRICS = ['kcal', 'sugars', 'salt', 'protein'] as const;
const TRACKED = [...TOP_METRICS, 'fiber'] as const; // fibre is tracked per food for the hint, but not exposed as a list
const TOP_N = 8;
const EPS = 1e-9;
const MIN_LOGGED_DAYS = 7;
const MAX_HINTS = 4;
const FAST_LOSS_PCT = 1.0;
const SLEEP_SHORT_BELOW = 360;
const SLEEP_LONG_FROM = 420;
const SLEEP_MIN_DAYS = 5;
const TRAINING_MIN_DAYS = 5;
const TREND_HALF_WINDOW = 3;

export const adherenceClass = analysis.adherenceClass;

/** What `compute` needs of an entry. */
export interface EntryLike {
  day: string; meal: string; food_id: number | null; name: string; brand: string | null; amount: number; per_100: Per100; extra?: Record<string, number> | null;
}
export interface WorkoutLike { day: string; minutes: number | null }
export interface ComputeOptions {
  granularity?: string; light?: boolean; activity?: Record<string, ActivityRow>; workouts?: WorkoutLike[]; bonus?: Record<string, number>;
  sleep?: Record<string, number>; today?: string | null; workoutsWeek?: number;
}

type Slot = { name: string; brand: string | null; amount_total: number; value: number; times: number };
type Foods = Record<string, Map<string, Slot>>;

const has = (o: object, k: string) => Object.hasOwn(o, k);
const dayKeysOf = (first: string, nDays: number): string[] => Array.from({ length: nDays }, (_, i) => addDays(first, i));

/** Build the whole response for the days first..last (both included); `light` leaves out what only the main period needs. */
export function compute(
  first: string, last: string, rows: EntryLike[], weightsIn: WeightRow[], goal: Timeline | GoalValues | null,
  waterIn: Record<string, number> | null, opts: ComputeOptions = {},
): Record<string, any> {
  const { granularity = 'auto', light = false, today = null, workoutsWeek = 0 } = opts;
  const tl = asTimeline(goal);
  const nDays = daysBetween(first, last) + 1;
  const dayKeys = dayKeysOf(first, nDays);
  const keySet = new Set(dayKeys);
  const weights = weightsIn.filter((w) => keySet.has(w.day));
  const weightByDay: Record<string, number> = Object.fromEntries(weights.map((w) => [w.day, w.kg]));
  const water: Record<string, number> = Object.fromEntries(Object.entries(waterIn ?? {}).filter(([d]) => keySet.has(d)));
  const activity: Record<string, ActivityRow> = Object.fromEntries(Object.entries(opts.activity ?? {}).filter(([d]) => keySet.has(d)));
  const workoutMinutes: Record<string, number> = {};
  let workoutCount = 0;
  for (const w of opts.workouts ?? []) {
    if (keySet.has(w.day)) {
      workoutMinutes[w.day] = (workoutMinutes[w.day] ?? 0.0) + (w.minutes as number);
      workoutCount++;
    }
  }
  const bonus = opts.bonus ?? {};

  const totals: Totals = Object.fromEntries(dayKeys.map((d) => [d, Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, 0.0]))]));
  const logged = new Set<string>();
  const mealKcal: Record<string, number> = Object.fromEntries(MEALS.map((m) => [m, 0.0]));
  const foods: Foods = Object.fromEntries(TRACKED.map((m) => [m, new Map<string, Slot>()]));
  const grand: Record<string, number> = Object.fromEntries(TRACKED.map((m) => [m, 0.0]));
  const microParts: [number, nutrients.Extra][] = [];

  for (const row of rows) {
    const day = row.day;
    if (!has(totals, day)) continue;
    const values = Object.fromEntries(Object.entries(scale(row.per_100, row.amount)).map(([k, v]) => [k, v || 0.0])) as Record<string, number>;
    logged.add(day);
    for (const key of NUTRIENT_KEYS) totals[day][key] += values[key];
    mealKcal[row.meal] += values.kcal;
    if (light) continue;
    microParts.push([values.kcal, row.extra && Object.keys(row.extra).length ? nutrients.scaleExtra(row.extra, row.amount) : {}]);
    const ident = row.food_id !== null ? JSON.stringify(['id', row.food_id]) : JSON.stringify(['name', row.name, row.brand]);
    for (const metric of TRACKED) {
      grand[metric] += values[metric];
      let slot = foods[metric].get(ident);
      if (!slot) foods[metric].set(ident, (slot = { name: row.name, brand: row.brand, amount_total: 0.0, value: 0.0, times: 0 }));
      slot.amount_total += row.amount;
      slot.value += values[metric];
      slot.times += 1;
    }
  }

  const loggedDays = dayKeys.filter((d) => logged.has(d));
  const micros = light ? [] : microFromParts(microParts, loggedDays.length);
  const nLogged = loggedDays.length;
  const averages: Record<string, number> = {};
  for (const k of NUTRIENT_KEYS) averages[k] = r(mean(loggedDays.map((d) => totals[d][k])));
  averages.water_ml = r(mean(Object.values(water)), 0);
  averages.steps = r(mean(Object.values(activity).filter((a) => a.steps !== null).map((a) => a.steps!)), 0);
  averages.active_kcal = r(mean(Object.values(activity).filter((a) => a.active_kcal !== null).map((a) => a.active_kcal!)), 0);
  averages.workout_minutes = r(nDays ? pySum(Object.values(workoutMinutes)) / nDays : 0.0);

  const byWeekday = [];
  for (let wd = 0; wd < 7; wd++) {
    const vals = loggedDays.filter((d) => weekday(d) === wd).map((d) => totals[d].kcal);
    byWeekday.push({ weekday: wd, logged_days: vals.length, kcal: r(mean(vals)) });
  }

  const mealMean: Record<string, number> = Object.fromEntries(MEALS.map((m) => [m, nLogged ? mealKcal[m] / nLogged : 0.0]));
  const mealSum = pySum(Object.values(mealMean));
  const byMeal = MEALS.map((m) => ({ meal: m, kcal: r(mealMean[m]), share: mealSum ? roundHalfEven(mealMean[m] / mealSum, 3) : 0.0 }));

  const topFoods: Record<string, any[]> = {};
  for (const metric of TOP_METRICS) {
    topFoods[metric] = ranked(foods, metric).slice(0, TOP_N).map((s) => ({
      name: s.name, brand: s.brand, amount_total: r(s.amount_total), value: r(s.value),
      share: grand[metric] ? roundHalfEven(s.value / grand[metric], 3) : 0.0, times: s.times,
    }));
  }

  let adherence: { in_range_days: number; over_days: number; under_days: number } | null = null;
  if (tl) {
    const counts = { in: 0, over: 0, under: 0 };
    for (const d of loggedDays) counts[adherenceClass(totals[d].kcal, kcalOn(tl, bonus, d)!)]++;
    adherence = { in_range_days: counts.in, over_days: counts.over, under_days: counts.under };
  }

  const weight = weightSummary(weights);
  // the goal that counts, as a mean over the days with entries (each day's goal, plus its active energy when that is added)
  const periodGoal = tl ? goalPeriod(tl, loggedDays, dayKeys.at(-1)) : null;
  const goalKcal = tl ? r(loggedDays.length ? mean(loggedDays.map((d) => kcalOn(tl, bonus, d)!)) : periodGoal!.kcal!) : null;
  const resolved = analysis.resolveGranularity(granularity, nDays);
  const weightPoints = weights.map((w): [number, number] => [daysBetween(first, w.day), w.kg]);
  const body = analysis.bodyPoints(weights, first);
  const [comp, compMissing] = analysis.composition(body);
  const [expenditure, missing] = analysis.estimateExpenditure(nDays, nLogged, averages.kcal, weightPoints, goalKcal, body);
  const result: Record<string, any> = {
    range: { from: first, to: last, days: nDays, logged_days: nLogged },
    goal: tl ? current(tl) : null,
    period_goal: periodGoal,
    goal_kcal: goalKcal,
    steps_goal: periodGoal?.steps ?? activityRules.DEFAULT_STEPS_GOAL,
    averages,
    weight,
    composition: comp,
    composition_missing: weights.length ? compMissing : [],
    rate: analysis.weightRate(weightPoints),
    adherence,
    expenditure,
    expenditure_missing: missing,
    granularity: resolved,
    series: analysis.buildSeries(first, last, resolved, totals, logged, water, weightByDay, tl, bonus, activity, workoutMinutes),
  };
  if (light) return result;
  const ctx: Context = { loggedDays, totals, averages, goal: periodGoal, byMeal, timeline: tl, adherence, foods, composition: comp, rate: result.rate };
  const detailed = nDays <= analysis.DETAIL_DAYS; // beyond this the per-day lists would only bloat the response
  return {
    ...result,
    days: detailed ? dayKeys.map((d) => ({
      day: d, logged: logged.has(d), ...Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, r(totals[d][k])])), weight: weightByDay[d] ?? null,
      water_ml: water[d] ?? null, steps: has(activity, d) ? activity[d].steps : null,
      active_kcal: has(activity, d) ? activity[d].active_kcal : null,
      workout_minutes: r(workoutMinutes[d] ?? 0.0), goal_kcal: tl ? kcalOn(tl, bonus, d) : null,
    })) : [],
    calendar: detailed ? analysis.buildCalendar(dayKeys, totals, logged, tl, bonus) : [],
    by_weekday: byWeekday,
    by_meal: byMeal,
    top_foods: topFoods,
    micros,
    hints: hints(ctx),
    sleep: sleepSummary(Object.fromEntries(Object.entries(opts.sleep ?? {}).filter(([d]) => keySet.has(d))), loggedDays, totals, tl, bonus, today),
    training: workoutCount ? trainingSummary(first, last, opts.workouts ?? [], workoutsWeek, loggedDays, totals, tl, bonus, today) : null,
  };
}

/** The foods with a value above 0, highest first (ties keep the order they were first seen). */
const ranked = (foods: Foods, metric: string): Slot[] => [...foods[metric].values()].filter((s) => s.value > 0).sort((a, b) => b.value - a.value);

/** Training days and eating (see insights.py). A pattern in the data, not a proof of a cause. */
function trainingSummary(
  first: string, last: string, workouts: WorkoutLike[], goal: number, loggedDays: string[], totals: Totals, tl: Timeline | null,
  bonus: Record<string, number>, today: string | null,
) {
  const trainedAll = activityRules.trainingDays(workouts);
  const inside = new Set([...trainedAll].filter((d) => first <= d && d <= last));
  const counts = activityRules.weeklyCounts(trainedAll);
  const weeks = [];
  for (let monday = activityRules.weekStart(first); monday <= last; monday = addDays(monday, 7)) {
    weeks.push({ week_start: monday, training_days: counts.get(activityRules.weekNumber(monday)) ?? 0 });
  }
  const days = loggedDays.filter((d) => d !== today);
  const trained = days.filter((d) => inside.has(d));
  const rest = days.filter((d) => !inside.has(d));
  const full = trained.length >= TRAINING_MIN_DAYS && rest.length >= TRAINING_MIN_DAYS;
  return {
    training_days: inside.size,
    workout_minutes: r(pySum(workouts.filter((w) => first <= w.day && w.day <= last).map((w) => w.minutes as number))),
    weeks,
    goal: goal || null,
    min_days: TRAINING_MIN_DAYS,
    trained: eatingGroup(trained, full, totals, tl, bonus),
    rest: eatingGroup(rest, full, totals, tl, bonus),
  };
}

function eatingGroup(chosen: string[], full: boolean, totals: Totals, tl: Timeline | null, bonus: Record<string, number>) {
  return {
    days: chosen.length,
    kcal: full ? r(mean(chosen.map((d) => totals[d].kcal))) : null,
    protein: full ? r(mean(chosen.map((d) => totals[d].protein))) : null,
    kcal_vs_goal: full && tl ? r(mean(chosen.map((d) => totals[d].kcal - kcalOn(tl, bonus, d)!))) : null,
  };
}

/** Sleep against eating: null without any night in the period (see insights.py). */
function sleepSummary(
  sleep: Record<string, number>, loggedDays: string[], totals: Totals, tl: Timeline | null, bonus: Record<string, number>, today: string | null,
) {
  if (!Object.keys(sleep).length) return null;
  const days = loggedDays.filter((d) => has(sleep, d) && d !== today);
  const short = days.filter((d) => sleep[d] < SLEEP_SHORT_BELOW);
  const long = days.filter((d) => sleep[d] >= SLEEP_LONG_FROM);
  const group = (chosen: string[]) => eatingGroup(chosen, chosen.length >= SLEEP_MIN_DAYS, totals, tl, bonus);
  return {
    nights: Object.keys(sleep).length,
    avg_minutes: roundHalfEven(mean(Object.values(sleep))),
    compared_days: days.length,
    middle_days: days.length - short.length - long.length,
    min_days: SLEEP_MIN_DAYS,
    short: group(short),
    long: group(long),
  };
}

/** Vitamins, minerals and other additional nutrients: mean per day with entries and how well they are known. */
function microFromParts(parts: [number, nutrients.Extra][], nLogged: number) {
  const found = nutrients.aggregate(parts);
  const result = [];
  for (const [key, v] of Object.entries(found)) {
    const info = nutrients.BY_KEY.get(key)!;
    const average = nLogged ? v.amount / nLogged : 0.0;
    result.push({
      key, group: info.group, unit: info.unit, nrv: info.nrv, average: r(average, 3), coverage: roundHalfEven(v.coverage, 3),
      percent_nrv: info.nrv ? r((average / info.nrv) * 100, 1) : null,
    });
  }
  result.sort((a, b) => b.coverage - a.coverage); // stable: ties keep the directory order
  return result.filter((m) => m.coverage > 0);
}

/** First, last and change of the raw values plus a smoothed trend; null without any weight. */
function weightSummary(weights: WeightRow[]) {
  if (!weights.length) return null;
  const points = [...weights].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const kgs = points.map((w) => w.kg);
  const trend = smoothTrend(points.map((w) => w.day), kgs, 2);
  const fat: [string, number][] = [];
  for (const w of points) {
    const p = analysis.fatPct(w);
    if (p !== null) fat.push([w.day, p]);
  }
  return {
    first: kgs[0],
    last: kgs.at(-1)!,
    change: r(kgs.at(-1)! - kgs[0], 2),
    trend: trend.map(([day, kg]) => ({ day, kg })),
    raw: points.map((w) => ({ day: w.day, kg: w.kg })),
    body_fat: fat.map(([day, p]) => ({ day, pct: r(p, 1) })),
    body_fat_trend: smoothTrend(fat.map((f) => f[0]), fat.map((f) => f[1]), 1).map(([day, pct]) => ({ day, pct })),
  };
}

/** Mean of the values within TREND_HALF_WINDOW days around each day; `days` sorted ascending. */
function smoothTrend(days: string[], values: number[], digits: number): [string, number][] {
  const ords = days.map(toOrdinal);
  const trend: [string, number][] = [];
  let lo = 0, hi = 0, running = 0.0;
  ords.forEach((o, i) => {
    while (hi < ords.length && ords[hi] <= o + TREND_HALF_WINDOW) running += values[hi++];
    while (ords[lo] < o - TREND_HALF_WINDOW) running -= values[lo++];
    trend.push([days[i], r(running / (hi - lo), digits)]);
  });
  return trend;
}

// hints --------------------------------------------------------------------------------------------------------------

interface Context {
  loggedDays: string[]; totals: Totals; averages: Record<string, number>; goal: Partial<GoalValues> | null;
  byMeal: { meal: string; kcal: number; share: number }[]; timeline: Timeline | null; adherence: { in_range_days: number } | null;
  foods: Foods; composition: Record<string, any> | null; rate: Record<string, any> | null;
}
type Hint = { code: string; params: Record<string, unknown> } | null;

const topNames = (c: Context, metric: string, n: number): string[] => ranked(c.foods, metric).slice(0, n).map((s) => s.name);

/** Protein averages below 80 % of the protein goal. */
function hintLowProtein(c: Context): Hint {
  if (!c.goal || !(c.goal.protein! > 0)) return null;
  const avg = c.averages.protein, goal = c.goal.protein!;
  if (avg < 0.8 * goal) return { code: 'low_protein', params: { avg: r(avg, 0), goal: r(goal, 0), pct: roundHalfEven((avg / goal) * 100) } };
  return null;
}

/** Lean mass fell by at least 0.5 kg in the period while protein averages below the protein goal. */
function hintLeanLoss(c: Context): Hint {
  const comp = c.composition;
  if (!comp || !c.goal || !(c.goal.protein! > 0) || comp.lean_change_kg > -0.5 + EPS) return null;
  if (c.averages.protein < c.goal.protein!) {
    return { code: 'lean_loss', params: { lean: r(Math.abs(comp.lean_change_kg), 1), avg: r(c.averages.protein, 0), goal: r(c.goal.protein!, 0) } };
  }
  return null;
}

/** Weight falls by more than 1 % of the body weight a week (regression line). */
function hintFastLoss(c: Context): Hint {
  const rate = c.rate;
  if (rate && rate.pct_per_week < -FAST_LOSS_PCT) return { code: 'fast_loss', params: { pct: r(Math.abs(rate.pct_per_week), 1), kg: r(Math.abs(rate.kg_per_week), 1) } };
  return null;
}

/** Fibre averages below 25 g a day; names the two foods that supplied the most fibre. */
function hintLowFiber(c: Context): Hint {
  if (c.averages.fiber < 25) return { code: 'low_fiber', params: { avg: r(c.averages.fiber, 0), top: topNames(c, 'fiber', 2) } };
  return null;
}

/** Sugars average above 50 g a day; names the biggest sugar supplier. */
function hintHighSugar(c: Context): Hint {
  if (c.averages.sugars > 50) {
    const top = topNames(c, 'sugars', 1);
    return { code: 'high_sugar', params: { avg: r(c.averages.sugars, 0), top: top.length ? top[0] : null } };
  }
  return null;
}

/** Salt averages above 6 g a day. */
function hintHighSalt(c: Context): Hint {
  if (c.averages.salt > 6) return { code: 'high_salt', params: { avg: r(c.averages.salt, 1) } };
  return null;
}

/** Saturday and Sunday average more than 15 % above Monday to Friday (needs two weekend and three weekdays). */
function hintWeekendHigher(c: Context): Hint {
  const weekend: number[] = [], workdays: number[] = [];
  for (const d of c.loggedDays) (weekday(d) >= 5 ? weekend : workdays).push(c.totals[d].kcal);
  if (weekend.length < 2 || workdays.length < 3) return null;
  const w = mean(weekend), d = mean(workdays);
  if (d > 0 && w > d * 1.15) return { code: 'weekend_higher', params: { weekend: roundHalfEven(w), weekday: roundHalfEven(d), pct: roundHalfEven((w / d - 1) * 100) } };
  return null;
}

/** One meal makes up more than 45 % of the day's calories (on average). */
function hintMealDominant(c: Context): Hint {
  let top = c.byMeal[0];
  for (const m of c.byMeal) if (m.share > top.share) top = m; // max(): the first of equal values wins
  if (top.share > 0.45) return { code: 'meal_dominant', params: { meal: top.meal, pct: roundHalfEven(top.share * 100), kcal: roundHalfEven(top.kcal) } };
  return null;
}

/** Positive: the protein goal was reached on at least 70 % of the days with entries. */
function hintProteinGoalMet(c: Context): Hint {
  if (!c.goal || !(c.goal.protein! > 0) || !c.loggedDays.length) return null;
  const tl = c.timeline!;
  const hit = c.loggedDays.filter((d) => { const g = goalOn(tl, d).protein; return g > 0 && c.totals[d].protein >= g - EPS; }).length;
  const pct = hit / c.loggedDays.length;
  if (pct >= 0.7) return { code: 'protein_goal_met', params: { days: hit, of: c.loggedDays.length, pct: roundHalfEven(pct * 100) } };
  return null;
}

/** Positive: at least 70 % of the days with entries were within 90-110 % of the calorie goal. */
function hintInRange(c: Context): Hint {
  if (!c.adherence || !c.loggedDays.length) return null;
  const hit = c.adherence.in_range_days, total = c.loggedDays.length;
  if (hit / total >= 0.7) return { code: 'in_range', params: { days: hit, of: total, pct: roundHalfEven((hit / total) * 100) } };
  return null;
}

// order = importance: things to look at first, then the positive notes
const RULES = [hintLowProtein, hintLeanLoss, hintFastLoss, hintLowFiber, hintHighSugar, hintHighSalt, hintWeekendHigher, hintMealDominant, hintInRange, hintProteinGoalMet];

/** At most four hints, most important first; a single `few_days` below seven days with entries. */
function hints(c: Context): { code: string; params: Record<string, unknown> }[] {
  if (c.loggedDays.length < MIN_LOGGED_DAYS) return [{ code: 'few_days', params: { logged_days: c.loggedDays.length, min: MIN_LOGGED_DAYS } }];
  const found: { code: string; params: Record<string, unknown> }[] = [];
  for (const rule of RULES) {
    const h = rule(c);
    if (h) found.push(h);
  }
  return found.slice(0, MAX_HINTS);
}

