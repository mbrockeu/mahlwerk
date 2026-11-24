// Water drunk per day, one total per day (routes/water.py).
import { dayDrinksMl } from '../hydration.ts';
import { parse, route, type Req, type Route } from '../http.ts';
import { waterAdd, waterSet } from '../models/body.ts';
import { DEFAULT_WATER_GOAL, goalOn } from '../store/goals.ts';
import { MAX_WATER_ML, addWater, putWater } from '../store/water.ts';
import { emit } from '../webhooks.ts';
import { parseDay } from './diary.ts';

async function out(req: Req, day: string, ml: number) {
  const { db } = req.ctx;
  const uid = req.user!.id;
  const goal = await goalOn(db, uid, day);
  const water = { ml, goal_ml: goal?.water_ml ?? DEFAULT_WATER_GOAL, drinks_ml: await dayDrinksMl(db, uid, day) };
  emit(req, req.user!, 'water.changed', { day, ml: water.ml, goal_ml: water.goal_ml });
  return water;
}

export const routes: Route[] = [
  // Add or take back some ml; the total is kept between 0 and 10000 ml.
  route('POST', '/api/v1/water/{day}', async (req) => {
    const body = parse(waterAdd, req.body);
    parseDay(req.params.day);
    return out(req, req.params.day, await addWater(req.ctx.db, req.user!.id, req.params.day, body.add_ml));
  }),
  route('PUT', '/api/v1/water/{day}', async (req) => {
    const body = parse(waterSet, req.body);
    parseDay(req.params.day);
    return out(req, req.params.day, await putWater(req.ctx.db, req.user!.id, req.params.day, Math.min(body.ml, MAX_WATER_ML)));
  }),
];
