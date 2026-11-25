// The food diary: one day with its meals, entries, and the history across days (routes/diary.py).
import * as activity from '../activity.ts';
import { dayActivities } from '../activityViews.ts';
import { addDays, dayToDate, today } from '../dates.ts';
import { HttpError, parse, pathInt, queryObject, route, type Req, type Route } from '../http.ts';
import { z } from 'zod';
import { dayDrinksMl, drinksByDay, waterDrinksOn } from '../hydration.ts';
import { MEALS, type Meal } from '../models/common.ts';
import { copyIn, entryIn, entryPatch, type Day, type Entry, type HistoryDay } from '../models/diary.ts';
import { pyInt } from '../models/common.ts';
import * as nutrients from '../nutrients.ts';
import { PER_100_KEYS, r1, scale, total, type Per100, type Scaled } from '../nutrition.ts';
import { pySum, roundHalfEven } from '../num.ts';
import { drinkEntries, addEntries, addEntry, deleteEntry, entriesBetween, entriesOn, getEntries, getEntry, loggedDaysUntil, macrosBetween, updateEntry, type EntryRow, type Snapshot } from '../store/diary.ts';
import { getFood } from '../store/foods.ts';
import { DEFAULT_WATER_GOAL, goalOn } from '../store/goals.ts';
import { getSettings } from '../store/settings.ts';
import { getWater, waterBetween } from '../store/water.ts';
import { emit, hooksWanted } from '../webhooks.ts';

export function parseDay(day: string): string {
  if (dayToDate(day) === null) throw new HttpError(422, 'day must be a date like 2025-01-31');
  return day;
}

const scaled = (row: EntryRow): Scaled => scale(row.per_100, row.amount);
const kcalOf = (row: EntryRow): number => scaled(row).kcal ?? 0;

export function entryOut(row: EntryRow): Entry {
  const n = scaled(row);
  const v = (k: 'kcal' | 'protein' | 'carbs' | 'fat') => (n[k] === null ? null : r1(n[k]));
  return {
    id: row.id, food_id: row.food_id, meal: row.meal as Meal, name: row.name, brand: row.brand, amount: row.amount, unit: row.unit,
    kcal: v('kcal'), protein: v('protein'), carbs: v('carbs'), fat: v('fat'),
  };
}

/** The stored copy of an entry (or a template item), ready to be inserted again. */
export const snapshot = (row: EntryRow, meal?: string | null) => ({
  meal: meal || row.meal, food_id: row.food_id, amount: row.amount, unit: row.unit, name: row.name, brand: row.brand,
  per_100: row.per_100, extra: row.extra,
});

/** The payload of the entry webhooks: the entry in short and the energy of its day so far (`days` keeps the day sums of one batch:
 * all its entries are written before the first event is built, so the sum of a day is the same for each). */
async function entryEvent(req: Req, row: EntryRow, days = new Map<string, number>()) {
  const entry = entryOut(row);
  if (!days.has(row.day)) days.set(row.day, pySum((await entriesOn(req.ctx.db, req.user!.id, row.day)).map(kcalOf)));
  const dayKcal = days.get(row.day)!;
  return {
    entry: { id: entry.id, name: entry.name, brand: entry.brand, amount: entry.amount, unit: entry.unit, kcal: entry.kcal, meal: entry.meal, day: row.day },
    day: row.day,
    day_kcal: r1(dayKcal),
  };
}

/** The `entry.created` events of new entries; nothing is built when no hook takes them. */
export async function emitEntries(req: Req, rows: EntryRow[]): Promise<void> {
  if (!rows.length || !(await hooksWanted(req, req.user!, 'entry.created'))) return;
  const days = new Map<string, number>();
  for (const row of rows) emit(req, req.user!, 'entry.created', await entryEvent(req, row, days));
}

/** The food an entry is booked from and the snapshot the entry keeps of it (404 for an unknown food). */
export async function foodCopy(req: Req, foodId: number): Promise<{ id: number; copy: Snapshot }> {
  const food = await getFood(req.ctx.db, foodId, Boolean(req.user!.is_demo));
  if (!food || !food.found) throw new HttpError(404, 'unknown food');
  const data = food.data!;
  return {
    id: food.id,
    copy: { name: data.name || food.code || 'Unnamed', brand: data.brand ?? null, unit: data.unit || 'g', per_100: data.per_100, extra: nutrients.clean(data.extra) },
  };
}

async function ownEntry(req: Req, entryId: number): Promise<EntryRow> {
  const row = await getEntry(req.ctx.db, req.user!.id, entryId);
  if (!row) throw new HttpError(404, 'unknown entry');
  return row;
}

async function getDay(req: Req): Promise<Day> {
  const day = req.params.day;
  parseDay(day);
  const { db, user } = { db: req.ctx.db, user: req.user! };
  const uid = user.id;
  const weekStart = addDays(day, -6);
  const rows = await entriesBetween(db, uid, weekStart, day);
  const todays = rows.filter((r) => r.day === day);

  const meals = Object.fromEntries(MEALS.map((m) => [m, { kcal: 0.0, entries: [] as Entry[] }])) as Record<Meal, { kcal: number; entries: Entry[] }>;
  for (const row of todays) meals[row.meal as Meal].entries.push(entryOut(row));
  for (const meal of MEALS) meals[meal].kcal = r1(pySum(todays.filter((r) => r.meal === meal).map(kcalOf)));

  const kcalByDay = new Map<string, number>();
  for (const row of rows) kcalByDay.set(row.day, (kcalByDay.get(row.day) ?? 0) + kcalOf(row));
  const week = [];
  for (let offset = 6; offset >= 0; offset--) {
    const d = addDays(day, -offset);
    week.push({ day: d, logged: kcalByDay.has(d), kcal: r1(kcalByDay.get(d) ?? 0) });
  }

  const previous = addDays(day, -1);
  const yesterday: Day['yesterday'] = {};
  for (const meal of MEALS) {
    const before = rows.filter((r) => r.day === previous && r.meal === meal);
    if (before.length) yesterday[meal] = { kcal: r1(pySum(before.map(kcalOf))), names: before.map((r) => r.name) };
  }

  const logged = new Set(await loggedDaysUntil(db, uid, day));
  let streak = 0;
  for (let cursor = day; logged.has(cursor); cursor = addDays(cursor, -1)) streak++;

  const goal = await goalOn(db, uid, day); // a past day keeps the goal it had
  const sums = total(todays.map(scaled));
  const extraTotals = nutrients.aggregate(todays.map((r): [number, nutrients.Extra] => [kcalOf(r), nutrients.scaleExtra(r.extra, r.amount)]));
  const todaysActivity = (await dayActivities(db, uid, day, day, goal))[day];
  return {
    day,
    goal,
    kcal_goal: goal ? roundHalfEven(activity.dayGoalKcal(goal.kcal, { [day]: todaysActivity.bonus_kcal }, day)!) : null,
    water: { ml: await getWater(db, uid, day), goal_ml: goal?.water_ml ?? DEFAULT_WATER_GOAL, drinks_ml: await dayDrinksMl(db, uid, day) },
    activity: todaysActivity,
    totals: Object.fromEntries(PER_100_KEYS.map((k) => [k, r1(sums[k])])) as Day['totals'],
    extra_totals: Object.fromEntries(Object.entries(extraTotals).map(([k, v]) => [k, { amount: roundHalfEven(v.amount, 3), coverage: roundHalfEven(v.coverage, 3) }])),
    meals,
    yesterday,
    streak,
    week,
  };
}

export const entriesOut = (rows: EntryRow[]) => ({ entries: rows.map(entryOut) });

export const routes: Route[] = [
  route('GET', '/api/v1/diary/{day}', getDay),

  route('POST', '/api/v1/diary/{day}/entries', async (req) => {
    const body = parse(entryIn, req.body);
    parseDay(req.params.day);
    const { id, copy } = await foodCopy(req, body.food_id);
    const entryId = await addEntry(req.ctx.db, req.user!.id, req.params.day, body.meal, id, body.amount, copy);
    const row = (await getEntry(req.ctx.db, req.user!.id, entryId))!;
    await emitEntries(req, [row]);
    return entryOut(row);
  }, { status: 201 }),

  // Copy the stored entries of another day (or one meal of it) to this day, snapshots and all.
  route('POST', '/api/v1/diary/{day}/copy', async (req) => {
    const body = parse(copyIn, req.body);
    const day = req.params.day;
    parseDay(day);
    parseDay(body.from_day);
    if (body.from_day === day && body.to_meal === null) throw new HttpError(422, 'from_day equals day: say which meal to copy into (to_meal)');
    const rows = await entriesOn(req.ctx.db, req.user!.id, body.from_day, body.meal);
    if (!rows.length) throw new HttpError(404, 'nothing to copy');
    const ids = await addEntries(req.ctx.db, req.user!.id, day, rows.map((r) => snapshot(r, body.to_meal || r.meal)));
    const added = await getEntries(req.ctx.db, req.user!.id, ids);
    await emitEntries(req, added);
    return entriesOut(added);
  }, { status: 201 }),

  route('PATCH', '/api/v1/diary/entries/{entry_id}', async (req) => {
    const entryId = pathInt(req, 'entry_id');
    const body = parse(entryPatch, req.body);
    const { db } = req.ctx;
    const uid = req.user!.id;
    await ownEntry(req, entryId);
    if (body.amount === null && body.meal === null && body.food_id === null) throw new HttpError(422, 'nothing to change');
    const food = body.food_id !== null ? await foodCopy(req, body.food_id) : null;
    await updateEntry(db, uid, entryId, body.amount, body.meal, food?.id ?? null, food?.copy ?? null);
    const row = (await getEntry(db, uid, entryId))!;
    emit(req, req.user!, 'entry.updated', await entryEvent(req, row));
    return entryOut(row);
  }),

  route('DELETE', '/api/v1/diary/entries/{entry_id}', async (req) => {
    const entryId = pathInt(req, 'entry_id');
    const row = await getEntry(req.ctx.db, req.user!.id, entryId);
    if (!row || !(await deleteEntry(req.ctx.db, req.user!.id, entryId))) throw new HttpError(404, 'unknown entry');
    emit(req, req.user!, 'entry.deleted', await entryEvent(req, row));
    return undefined;
  }, { status: 204 }),

  route('GET', '/api/v1/history', async (req): Promise<HistoryDay[]> => {
    const { days } = parse(z.object({ days: pyInt().pipe(z.number().min(1).max(366)).default(14) }), queryObject(req.query), 'query');
    const { db } = req.ctx;
    const uid = req.user!.id;
    const last = today();
    const first = addDays(last, -(days - 1));
    const byDay = new Map<string, Scaled[]>(); // only the four values the history shows travel (scale gives null for the rest)
    for (const row of await macrosBetween(db, uid, first, last)) byDay.set(row.day, [...(byDay.get(row.day) ?? []), scale(row.per_100 as Per100, row.amount)]);
    const water = await waterBetween(db, uid, first, last);
    const drinks = waterDrinksOn(await getSettings(db, uid)) ? drinksByDay(await drinkEntries(db, uid, first, last)) : {};
    const result: HistoryDay[] = [];
    for (let offset = 0; offset < days; offset++) {
      const d = addDays(first, offset);
      const sums = total(byDay.get(d) ?? []);
      result.push({
        day: d, kcal: r1(sums.kcal), protein: r1(sums.protein), carbs: r1(sums.carbs), fat: r1(sums.fat), logged: byDay.has(d),
        water_ml: water[d] ?? 0, water_drinks_ml: drinks[d] ?? 0,
      });
    }
    return result;
  }),
];
