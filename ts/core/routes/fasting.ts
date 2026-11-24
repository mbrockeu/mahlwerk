// Intervall fasting (routes/fasting.py): at most one open fast per user, finished ones as history. Times are unix seconds (UTC).
import { HttpError, parse, pathInt, route, type Req, type Route } from '../http.ts';
import { fastPatch, fastStart, fastStop } from '../models/body.ts';
import { currentFast, deleteFast, getFast, recentFasts, startFast, updateFast, type FastRow } from '../store/fasting.ts';
import { getSettings } from '../store/settings.ts';
import { emit } from '../webhooks.ts';

const MAX_BACKDATE = 48 * 3600;
const SKEW = 60; // tolerated clock difference between browser and server, in seconds
const RECENT = 14;

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function fastOut(row: FastRow, now: number) {
  const end = row.ended_at !== null ? row.ended_at : now;
  const elapsed = Math.max(0, end - row.started_at);
  return {
    id: row.id, started_at: row.started_at, ended_at: row.ended_at, target_hours: row.target_hours, elapsed_seconds: elapsed,
    duration_seconds: row.ended_at !== null ? elapsed : null, target_reached: elapsed >= row.target_hours * 3600,
  };
}

async function own(req: Req, fastId: number): Promise<FastRow> {
  const row = await getFast(req.ctx.db, req.user!.id, fastId);
  if (!row) throw new HttpError(404, 'unknown fast');
  return row;
}

/** An optional body: none (or null) means all defaults. */
const bodyOrEmpty = (req: Req): unknown => req.body ?? {};

export const routes: Route[] = [
  route('GET', '/api/v1/fasting', async (req) => {
    const { db } = req.ctx;
    const uid = req.user!.id;
    const now = nowSeconds();
    const current = await currentFast(db, uid);
    const recent = (await recentFasts(db, uid, RECENT)).map((r) => fastOut(r, now));
    return { current: current ? fastOut(current, now) : null, last: recent[0] ?? null, recent };
  }),

  route('POST', '/api/v1/fasting/start', async (req) => {
    const body = parse(fastStart, bodyOrEmpty(req));
    const { db } = req.ctx;
    const uid = req.user!.id;
    const now = nowSeconds();
    const started = body.started_at === null ? now : body.started_at;
    if (started > now + SKEW) throw new HttpError(422, 'started_at must not be in the future');
    if (started < now - MAX_BACKDATE) throw new HttpError(422, 'started_at must not be more than 48 hours back');
    if (await currentFast(db, uid)) throw new HttpError(409, 'a fast is already running');
    let target = body.target_hours;
    if (target === null) target = (await getSettings(db, uid)).fasting?.target_hours ?? 16;
    const fastId = await startFast(db, uid, Math.min(started, now), target!);
    if (fastId === null) throw new HttpError(409, 'a fast is already running');
    const fast = fastOut((await getFast(db, uid, fastId))!, now);
    emit(req, req.user!, 'fasting.started', fast);
    return fast;
  }, { status: 201 }),

  route('POST', '/api/v1/fasting/stop', async (req) => {
    const body = parse(fastStop, bodyOrEmpty(req));
    const { db } = req.ctx;
    const uid = req.user!.id;
    const now = nowSeconds();
    const current = await currentFast(db, uid);
    if (!current) throw new HttpError(409, 'no fast is running');
    const ended = body.ended_at === null ? now : body.ended_at;
    if (ended > now + SKEW) throw new HttpError(422, 'ended_at must not be in the future');
    if (ended < current.started_at) throw new HttpError(422, 'ended_at must not be before the start');
    await updateFast(db, uid, current.id, { ended_at: Math.min(ended, now) });
    const fast = fastOut((await getFast(db, uid, current.id))!, now);
    emit(req, req.user!, 'fasting.ended', fast);
    return fast;
  }),

  // Correct a fast. Giving `ended_at` to the open fast finishes it.
  route('PATCH', '/api/v1/fasting/{fast_id}', async (req) => {
    const fastId = pathInt(req, 'fast_id');
    const body = parse(fastPatch, req.body);
    const { db } = req.ctx;
    const uid = req.user!.id;
    const row = await own(req, fastId);
    const changes = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null)) as Record<string, number>; // exclude_none
    if (!Object.keys(changes).length) throw new HttpError(422, 'nothing to change');
    const now = nowSeconds();
    const merged = { ...row, ...changes };
    if (merged.started_at > now + SKEW) throw new HttpError(422, 'started_at must not be in the future');
    if (merged.ended_at !== null) {
      if (merged.ended_at > now + SKEW) throw new HttpError(422, 'ended_at must not be in the future');
      if (merged.ended_at < merged.started_at) throw new HttpError(422, 'ended_at must not be before the start');
    }
    if (!(await updateFast(db, uid, fastId, changes))) throw new HttpError(409, 'a fast is already running');
    const fast = fastOut((await getFast(db, uid, fastId))!, now);
    if (row.ended_at === null && fast.ended_at !== null) emit(req, req.user!, 'fasting.ended', fast); // the open fast was finished
    return fast;
  }),

  route('DELETE', '/api/v1/fasting/{fast_id}', async (req) => {
    const fastId = pathInt(req, 'fast_id');
    if (!(await deleteFast(req.ctx.db, req.user!.id, fastId))) throw new HttpError(404, 'unknown fast');
  }, { status: 204 }),
];
