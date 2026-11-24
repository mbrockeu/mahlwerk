// Activity: steps and active energy per day, workouts, and the bulk interface for Apple Health (routes/activity.py).
import { z } from 'zod';
import * as rules from '../activity.ts';
import { dayActivities, workoutOut } from '../activityViews.ts';
import { addDays, today } from '../dates.ts';
import { HttpError, parse, pathInt, queryObject, route, type Req, type Route } from '../http.ts';
import { activityPut, healthSync as healthSyncIn, workoutIn, workoutPatch } from '../models/health.ts';
import { pyInt } from '../models/common.ts';
import type { DayActivity } from '../models/activity.ts';
import { weightFor } from '../store/activity.ts';
import { putActivity, getWorkout, addWorkout, updateWorkout, deleteWorkout, healthSync, type SyncDay } from '../store/workouts.ts';
import { emit } from '../webhooks.ts';
import { parseDay } from './diary.ts';

const activityEvent = (day: string, a: DayActivity) => ({ day, steps: a.steps, active_kcal: a.active_kcal, distance_m: a.distance_m, source: a.source });

async function ownWorkout(req: Req, id: number) {
  const row = await getWorkout(req.ctx.db, req.user!.id, id);
  if (!row) throw new HttpError(404, 'unknown workout');
  return row;
}

export const routes: Route[] = [
  // The last N days ending today, oldest first, each with its steps, active energy and workouts.
  route('GET', '/api/v1/activity', async (req) => {
    const { days } = parse(z.object({ days: pyInt().pipe(z.number().min(1).max(366)).default(14) }), queryObject(req.query), 'query');
    const last = today();
    const found = await dayActivities(req.ctx.db, req.user!.id, addDays(last, -(days - 1)), last);
    return Object.entries(found).map(([day, a]) => ({ day, ...a }));
  }),

  // Set steps, active energy and/or distance of a day by hand: only the fields sent change, `null` clears one.
  route('PUT', '/api/v1/activity/{day}', async (req) => {
    const body = parse(activityPut, req.body);
    const day = req.params.day;
    parseDay(day);
    const changes = body as Record<string, number | null>; // absent keys stay absent
    if (!Object.keys(changes).length) throw new HttpError(422, 'nothing to change');
    await putActivity(req.ctx.db, req.user!.id, day, changes);
    const result = (await dayActivities(req.ctx.db, req.user!.id, day, day))[day];
    emit(req, req.user!, 'activity.recorded', activityEvent(day, result));
    return { day, ...result };
  }),

  route('POST', '/api/v1/workouts', async (req) => {
    const body = parse(workoutIn, req.body);
    parseDay(body.day);
    const [kind, name] = rules.resolveKind(body.kind, body.name);
    const uid = req.user!.id;
    const id = await addWorkout(req.ctx.db, uid, { ...body, kind, name }, Math.floor(Date.now() / 1000));
    const out = workoutOut((await getWorkout(req.ctx.db, uid, id))!, await weightFor(req.ctx.db, uid, body.day));
    emit(req, req.user!, 'workout.created', out as unknown as Record<string, unknown>);
    return out;
  }, { status: 201 }),

  route('PATCH', '/api/v1/workouts/{workout_id}', async (req) => {
    const id = pathInt(req, 'workout_id');
    const body = parse(workoutPatch, req.body);
    const uid = req.user!.id;
    const row = await ownWorkout(req, id);
    const changes = { ...body } as Record<string, any>; // the fields that were sent, `null` included
    if (!Object.keys(changes).length) throw new HttpError(422, 'nothing to change');
    for (const key of ['day', 'kind', 'minutes']) { // these have no empty value
      if (key in changes && changes[key] === null) throw new HttpError(422, `${key} cannot be cleared`);
    }
    if ('day' in changes) parseDay(changes.day);
    if ('kind' in changes) { // an unknown kind becomes `other` and its text the name
      [changes.kind, changes.name] = rules.resolveKind(changes.kind, 'name' in changes ? changes.name : row.name);
    } else if ('name' in changes) changes.name = (changes.name || '').trim();
    await updateWorkout(req.ctx.db, uid, id, changes);
    const updated = (await getWorkout(req.ctx.db, uid, id))!;
    return workoutOut(updated, await weightFor(req.ctx.db, uid, updated.day));
  }),

  route('DELETE', '/api/v1/workouts/{workout_id}', async (req) => {
    const id = pathInt(req, 'workout_id');
    if (!(await deleteWorkout(req.ctx.db, req.user!.id, id))) throw new HttpError(404, 'unknown workout');
  }, { status: 204 }),

  // Bulk interface for a shortcut that reads Apple Health: idempotent.
  route('POST', '/api/v1/health/sync', async (req) => {
    const body = parse(healthSyncIn, req.body);
    const days: SyncDay[] = body.days.map((item) => {
      parseDay(item.day);
      return { ...item, workouts: item.workouts.map((w) => { const [kind, name] = rules.resolveKind(w.kind, w.name); return { ...w, kind, name }; }) } as SyncDay;
    });
    const { db } = req.ctx;
    const uid = req.user!.id;
    const result = await healthSync(db, uid, days, body.overwrite_manual, Math.floor(Date.now() / 1000));
    const { changed } = result;
    if (changed.activity.length) {
      const sorted = [...changed.activity].sort();
      const found = await dayActivities(db, uid, sorted[0], sorted.at(-1)!);
      for (const day of new Set(changed.activity)) emit(req, req.user!, 'activity.recorded', activityEvent(day, found[day]));
    }
    for (const id of changed.workouts) {
      const row = (await getWorkout(db, uid, id))!;
      emit(req, req.user!, 'workout.created', workoutOut(row, await weightFor(db, uid, row.day)) as unknown as Record<string, unknown>);
    }
    return { days: days.length, ...result.counts };
  }),
];
