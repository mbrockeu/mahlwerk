// The user's goal, weights and test data (the goal, weight and demo-data handlers of routes/profile.py). The rest of that
// file (/me, settings, name, imports) belongs to the auth package.
import { DEFAULT_STEPS_GOAL } from '../activity.ts';
import { addDays, today } from '../dates.ts';
import { generate } from '../demo.ts';
import { HttpError, parse, queryObject, route, type Req, type Route } from '../http.ts';
import { demoIn, goalIn, weightIn } from '../models/body.ts';
import { pyInt } from '../models/common.ts';
import { DEFAULT_WATER_GOAL, getGoal, goalHistory, setGoal } from '../store/goals.ts';
import { removeDemo } from '../store/demo.ts';
import { deleteWeight, putWeight, weightsBetween } from '../store/weights.ts';
import { emit } from '../webhooks.ts';
import { parseDay } from './diary.ts';
import { z } from 'zod';

/** The host may hand in what has to happen after foods were removed (tidy the files nothing refers to any more). */
interface ImageService { sweep(): Promise<void> }

const demoEnabled = (req: Req): boolean => ['1', 'true'].includes((req.ctx.env.MAHLWERK_DEMO_DATA ?? '').trim().toLowerCase());
const needDemo = (req: Req): void => {
  if (!demoEnabled(req)) throw new HttpError(404, 'demo data is switched off');
};

const stripNull = (row: Record<string, any>) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null));

export const routes: Route[] = [
  // Fill the last N days with invented entries, weights, water, steps and workouts; days with real data stay untouched.
  route('POST', '/api/v1/me/demo-data', async (req) => {
    needDemo(req);
    const body = parse(demoIn, req.body ?? {});
    return generate(req.ctx.db, req.user!.id, today(), body.days, Math.floor(Date.now() / 1000));
  }),

  // Remove this user's demo entries and weights and the demo foods nothing refers to any more.
  route('DELETE', '/api/v1/me/demo-data', async (req) => {
    needDemo(req);
    const removed = await removeDemo(req.ctx.db, req.user!.id);
    await (req.ctx.services.images as ImageService | undefined)?.sweep(); // foods are gone: tidy the files nothing refers to
    return removed;
  }),

  route('PUT', '/api/v1/me/goal', async (req) => {
    const goal = parse(goalIn, req.body);
    const uid = req.user!.id;
    const saved = await getGoal(req.ctx.db, uid);
    const data = {
      kcal: goal.kcal, protein: goal.protein, carbs: goal.carbs, fat: goal.fat,
      // an older client does not know the water goal: keep it; nor the steps goal
      water_ml: goal.water_ml !== undefined ? goal.water_ml : saved?.water_ml ?? DEFAULT_WATER_GOAL,
      steps: goal.steps !== undefined ? goal.steps : saved?.steps ?? DEFAULT_STEPS_GOAL,
    };
    const validFrom = today(); // a change counts from today on; earlier days keep the goal they had
    await setGoal(req.ctx.db, uid, data, validFrom, Math.floor(Date.now() / 1000));
    emit(req, req.user!, 'goal.changed', { ...data, valid_from: validFrom });
    return data;
  }),

  // Every goal change, newest first; `valid_from` 0001-01-01 means "since the start". Empty without a goal.
  route('GET', '/api/v1/me/goal/history', async (req) => goalHistory(req.ctx.db, req.user!.id)),

  route('GET', '/api/v1/weights', async (req) => {
    const { days } = parse(z.object({ days: pyInt().pipe(z.number().min(1).max(3660)).default(90) }), queryObject(req.query), 'query');
    const last = today();
    return (await weightsBetween(req.ctx.db, req.user!.id, addDays(last, -(days - 1)), last));
  }),

  route('PUT', '/api/v1/weights/{day}', async (req) => {
    const body = parse(weightIn, req.body);
    parseDay(req.params.day);
    const given: { body_fat_pct?: number | null; lean_kg?: number | null } = {}; // omitted = keep what is stored
    if ('body_fat_pct' in body) given.body_fat_pct = body.body_fat_pct;
    if ('lean_kg' in body) given.lean_kg = body.lean_kg;
    const row = await putWeight(req.ctx.db, req.user!.id, req.params.day, body.kg, given);
    emit(req, req.user!, 'weight.recorded', { day: req.params.day, kg: body.kg });
    return stripNull(row);
  }),

  route('DELETE', '/api/v1/weights/{day}', async (req) => {
    parseDay(req.params.day);
    if (!(await deleteWeight(req.ctx.db, req.user!.id, req.params.day))) throw new HttpError(404, 'no weight for this day');
  }, { status: 204 }),
];
