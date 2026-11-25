// Evaluation of a date range (routes/insights.py): the insights, one nutrient curve, the foods list and detail, the weekly review.
import { z } from 'zod';
import * as activity from '../activity.ts';
import { goalBonuses } from '../activityViews.ts';
import * as analysis from '../analysis.ts';
import { mondayOfIsoWeek } from '../calendar.ts';
import { addDays, daysBetween, today } from '../dates.ts';
import { localDay } from '../calendar.ts';
import { foodDetail, foodsList, SORTS } from '../foodStats.ts';
import { HttpError, parse, queryObject, route, type Req, type Route } from '../http.ts';
import * as insights from '../insights.ts';
import { pyInt } from '../models/common.ts';
import * as review from '../review.ts';
import { entrySpan, badgesEarned } from '../store/badges.ts';
import { curveBetween, entriesBetween } from '../store/diary.ts';
import { goalTimeline } from '../store/goals.ts';
import { getSettings } from '../store/settings.ts';
import { sleepBetween } from '../store/workouts.ts';
import { weightsBetween } from '../store/weights.ts';
import { waterBetween } from '../store/water.ts';
import { activityBetween, workoutsBetween } from '../store/activity.ts';
import { period as goalPeriod } from '../goals.ts';
import { parseDay } from './diary.ts';

const MAX_DAYS = 3660; // ten years
const DEFAULT_DAYS = 30;
const granularity = z.enum(['day', 'week', 'month', 'auto']).default('auto');

/** The requested days (both included). `range=all` is first to last entry (the last 30 days without entries), `range=<n>` the
 * last n days; explicit `from`/`to` win. */
async function resolvePeriod(req: Req, from: string | undefined, to: string | undefined, range: string | undefined, maxDays = MAX_DAYS): Promise<[string, string]> {
  const { db } = req.ctx;
  const uid = req.user!.id;
  if (range === 'all' && !from && !to) {
    const span = await entrySpan(db, uid);
    const last = span ? span[1] : today();
    let first = span ? span[0] : addDays(last, -(DEFAULT_DAYS - 1));
    const earliest = addDays(last, -(maxDays - 1));
    if (earliest > first) first = earliest;
    return [first, last];
  }
  const last = to ? parseDay(to) : today();
  let first: string;
  if (from) first = parseDay(from);
  else if (range && /^[0-9]+$/.test(range) && Number(range) > 0) first = addDays(last, -(Number(range) - 1));
  else first = addDays(last, -(DEFAULT_DAYS - 1));
  if (first > last) throw new HttpError(422, 'from must not be after to');
  if (daysBetween(first, last) + 1 > maxDays) throw new HttpError(422, `at most ${maxDays} days`);
  return [first, last];
}

const periodQuery = { from: z.string().optional(), to: z.string().optional() };
const q = <T extends z.ZodRawShape>(shape: T, req: Req) => parse(z.object(shape), queryObject(req.query), 'query');

async function getInsights(req: Req) {
  const { db } = req.ctx;
  const { from, to, range, granularity: gran, compare } = q({ ...periodQuery, range: z.string().optional(), granularity, compare: z.literal('previous').optional() }, req);
  if (range !== undefined && range !== 'all' && !(/^[0-9]+$/.test(range) && Number(range) > 0)) throw new HttpError(422, "range must be 'all' or a number of days");
  const uid = req.user!.id;
  const [first, last] = await resolvePeriod(req, from, to, range);
  const goal = await goalTimeline(db, uid); // every day against its own goal
  const settings = await getSettings(db, uid);

  /** What one period needs besides entries and weights: water, activity, workouts and the goal bonus per day. */
  const period = async (a: string, b: string) => ({
    water: await waterBetween(db, uid, a, b), activity: await activityBetween(db, uid, a, b),
    workouts: await workoutsBetween(db, uid, a, b), bonus: await goalBonuses(db, uid, a, b, settings),
  });

  const extra = await period(first, last);
  // the training weeks of the period are whole calendar weeks, so its workouts reach to the Monday before and the Sunday after
  const workouts = await workoutsBetween(db, uid, activity.weekStart(first), addDays(activity.weekStart(last), 6));
  const result = insights.compute(first, last, await entriesBetween(db, uid, first, last), await weightsBetween(db, uid, first, last), goal, extra.water, {
    granularity: gran, sleep: await sleepBetween(db, uid, first, last), today: today(), workoutsWeek: activity.workoutsWeekOn(settings),
    activity: extra.activity as any, workouts: workouts as any, bonus: extra.bonus,
  });
  result.previous = null; // the response model lists them either way
  result.deltas = null;
  const span = await entrySpan(db, uid);
  result.first_day = span ? span[0] : null;
  result.last_day = span ? span[1] : null;
  if (compare === 'previous') {
    const n = result.range.days;
    const pLast = addDays(first, -1);
    const pFirst = addDays(pLast, -(n - 1));
    const before = await period(pFirst, pLast);
    const prev = insights.compute(pFirst, pLast, await entriesBetween(db, uid, pFirst, pLast), await weightsBetween(db, uid, pFirst, pLast), goal, before.water, {
      granularity: result.granularity, light: true, activity: before.activity as any, workouts: before.workouts as any, bonus: before.bonus,
    });
    const [block, deltas] = analysis.compareBlocks(result, prev);
    block.series = prev.series;
    result.previous = block;
    result.deltas = deltas;
  }
  return result;
}

async function getNutrient(req: Req) {
  const { db } = req.ctx;
  const { key, from, to, granularity: gran } = q({ key: z.string(), ...periodQuery, granularity }, req);
  const info = analysis.nutrientInfo(key);
  if (info === null) throw new HttpError(422, 'unknown nutrient key');
  const uid = req.user!.id;
  const [first, last] = await resolvePeriod(req, from, to, undefined);
  const rows = await curveBetween(db, uid, first, last, key); // only the values the curve adds up
  const resolved = analysis.resolveGranularity(gran, daysBetween(first, last) + 1);
  const tl = await goalTimeline(db, uid);
  const series = analysis.nutrientSeries(rows, key, first, last, resolved);
  const loggedDays = [...new Set(rows.map((r) => r.day))].sort();
  const goal = tl ? goalPeriod(tl, loggedDays, last) : null; // the mean goal of the logged days
  return {
    key, group: info.group, unit: info.unit, nrv: info.nrv,
    goal: goal && analysis.CORE_GOAL.includes(key) ? (goal as Record<string, number>)[key] : null,
    range: { from: first, to: last, days: daysBetween(first, last) + 1, logged_days: loggedDays.length },
    granularity: resolved,
    series,
    has_data: series.some((s) => s.average !== null && s.coverage > 0),
  };
}

async function getFoods(req: Req) {
  const { from, to, q: needle, sort, limit, offset } = q({
    ...periodQuery, q: z.string().default(''), sort: z.enum(SORTS).default('kcal'),
    limit: pyInt().pipe(z.number().min(1).max(200)).default(25), offset: pyInt().pipe(z.number().min(0)).default(0),
  }, req);
  const [first, last] = await resolvePeriod(req, from, to, undefined);
  const rows = await entriesBetween(req.ctx.db, req.user!.id, first, last);
  return { range: { from: first, to: last }, ...(await foodsList(rows, needle, sort, limit, offset)) };
}

async function getFoodDetail(req: Req) {
  const { key, from, to } = q({ key: z.string(), ...periodQuery }, req);
  const [first, last] = await resolvePeriod(req, from, to, undefined);
  const rows = await entriesBetween(req.ctx.db, req.user!.id, first, last);
  const detail = await foodDetail(rows, key, first, last);
  if (detail === null) throw new HttpError(404, 'no entries of this food in the period');
  return { range: { from: first, to: last }, ...detail };
}

/** '2026-W02' -> the Monday of that ISO week. */
function parseWeek(week: string): string {
  const m = /^(\d{4})-W(\d{2})\n?$/.exec(week);
  const monday = m ? mondayOfIsoWeek(Number(m[1]), Number(m[2])) : null;
  if (!monday) throw new HttpError(422, 'week must look like 2026-W07');
  return monday;
}

async function getReview(req: Req) {
  const { db } = req.ctx;
  const { week } = q({ week: z.string().optional() }, req);
  const monday = week ? parseWeek(week) : addDays(review.weekStart(today()), -7);
  const sunday = addDays(monday, 6);
  const uid = req.user!.id;
  const rows = await entriesBetween(db, uid, addDays(monday, -7), sunday);
  const codes: string[] = [];
  const settings = await getSettings(db, uid);
  if (Object.hasOwn(settings, 'playful') ? Boolean(settings.playful) : true) {
    for (const b of await badgesEarned(db, uid)) {
      const day = localDay(b.earned_at);
      if (monday <= day && day <= sunday) codes.push(b.code);
    }
  }
  const bonus = await goalBonuses(db, uid, addDays(monday, -7), sunday);
  return review.compute(monday, rows, await goalTimeline(db, uid), codes, bonus);
}

export const routes: Route[] = [
  route('GET', '/api/v1/insights', getInsights),
  route('GET', '/api/v1/insights/nutrient', getNutrient),
  route('GET', '/api/v1/insights/foods/detail', getFoodDetail),
  route('GET', '/api/v1/insights/foods', getFoods),
  route('GET', '/api/v1/review', getReview),
];
