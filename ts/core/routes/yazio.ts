// Yazio import in the app (routes/yazio.py): upload the files of the exporter (or a ZIP), look at the preview, confirm; or, when an admin
// switched it on, sign in at Yazio once and let the server fetch the diary. Both ways end in the same staging area and the same
// preview/confirm steps. Only for the signed-in person themself (an access token is refused) and only into their own account. The result
// is an import batch like any other: it can be taken back under "Imported data" in the profile.
import { z } from 'zod';
import { sessionUser } from '../auth.ts';
import { utf8 } from '../crypto.ts';
import { featureOn } from '../features.ts';
import { HttpError, parse, route, type Ctx, type Req, type Route } from '../http.ts';
import { nullish, pyBool, pyInt, pyStr } from '../models/common.ts';
import { pyLen, pyStrip } from '../text.ts';
import { FILES, YazioError, runImportFrom, type Summary } from '../yazio.ts';
import { Credentials, DEFAULT_MONTHS, LiveError, MAX_MONTHS, MAX_REFRESH_DAYS, Refused, Runs, appIdentity, runView } from '../yazioLive.ts';
import { MAX_FILE, StageError, Staging, UPLOAD_NAMES, decodeUpload, stageView } from '../yazioStage.ts';

const URL = '/api/v1/me/yazio';

interface YazioState { stage: Staging; runs: Runs }

/** The staging area and the runs of this app (one each, made on first use). Registers what has to end with a session or a switch. */
export function yazioOf(ctx: Ctx): YazioState {
  const existing = ctx.services.yazio as YazioState | undefined;
  if (existing) return existing;
  const stage = new Staging(() => ctx.now());
  ((ctx.services.sweepers ??= []) as (() => void)[]).push(() => stage.sweep());
  const runs = new Runs(ctx, async (userId, files) => {
    if (!(await featureOn(ctx, 'yazio_login.enabled'))) throw new LiveError('cancelled'); // switched off while the run was under way
    try {
      const { 'refresh.json': refresh, ...exporter } = files; // the period of a refresh is not one of the exporter's files
      stage.add(userId, Object.fromEntries(Object.entries(exporter).map(([name, value]) => [name, utf8(JSON.stringify(value))])), 'login', true, refresh ?? null);
    } catch (e) {
      if (e instanceof StageError) throw new LiveError('too_large');
      throw e;
    }
  });
  const state = { stage, runs };
  ctx.services.yazio = state;
  const ended = ctx.services.userEnded as ((id: number) => Promise<void> | void) | undefined;
  ctx.services.userEnded = async (id: number) => { // a running fetch ends with the session, what waits is dropped
    await ended?.(id);
    runs.cancel(id);
    stage.clear(id);
  };
  const off = ctx.services.connectorOff as ((updates: Record<string, unknown>) => Promise<void> | void) | undefined;
  ctx.services.connectorOff = async (updates: Record<string, unknown>) => { // fetches under way end; what they fetched is dropped at the next use
    await off?.(updates);
    if (updates['yazio_login.enabled'] === false) runs.cancelAll();
  };
  return state;
}

const sorted = (m: Map<string, number>): [string, number][] => [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

function previewOf(summary: Summary, token: string) {
  return {
    token, days: summary.days, entries: { product: summary.entries.product, recipe: summary.entries.recipe, quick: summary.entries.quick },
    entries_total: summary.total_entries, foods_created: summary.foods_created, foods_reused: summary.foods_reused, weights: summary.weights,
    weights_kept: summary.weights_kept, water: summary.water, water_kept: summary.water_kept, activity_days: summary.activity_days,
    activity_kept: summary.activity_kept, workouts: summary.workouts, workouts_already: summary.workouts_already, goal_set: summary.goal_set,
    already_imported: summary.already_imported,
    refresh: summary.refresh ? { ...summary.refresh, entries_seen: summary.entries_seen, workouts_seen: summary.workouts_seen } : null,
    entries_updated: summary.entries_updated, entries_removed: summary.entries_removed, workouts_updated: summary.workouts_updated,
    workouts_removed: summary.workouts_removed, weights_updated: summary.weights_updated, water_updated: summary.water_updated,
    activity_updated: summary.activity_updated, skipped: sorted(summary.skipped).map(([reason, count]) => ({ reason, count })),
    notes: sorted(summary.notes).map(([text, count]) => ({ text, count })), unknown_keys: summary.unknown_keys.size,
    dropped_values: summary.dropped_values, missing_files: summary.missing_files, batch_id: summary.batch_id, dry_run: summary.dry_run,
  };
}

const stageHttp = (e: StageError) => new HttpError(({ too_large: 413, busy: 503 } as Record<string, number>)[e.code] ?? 422, e.text);
const busy = (text: string, seconds = 3) => new HttpError(429, text, { 'retry-after': String(seconds) });

const confirmIn = z.object({ token: pyStr(0, 64), all_products: pyBool().default(false) });
const previewIn = z.object({ all_products: pyBool().default(false) });
// No limits declared on purpose: a validation error must never echo the password; the handler checks.
const loginIn = z.object({ email: z.string().default(''), password: z.string().default(''), months: nullish(pyInt()), days: nullish(pyInt()) });

/** The stored files as the parsed JSON objects of the exporter (null for a file that is not there). */
const loaded = (files: Record<string, Uint8Array>) =>
  Object.fromEntries(FILES.map((name) => [name, Object.hasOwn(files, name) ? JSON.parse(new TextDecoder().decode(files[name])) : null]));

async function importStaged(req: Req, allProducts: boolean, dryRun: boolean, token: string | null): Promise<[Summary, string]> {
  const { ctx } = req;
  const user = req.user!;
  const { stage: staging } = yazioOf(ctx);
  const stage = staging.get(user.id);
  if (!stage) throw new HttpError(410, 'nothing is waiting to be imported (it may have expired): upload the files again');
  if (token !== null && token !== stage.token) throw new HttpError(409, 'the files changed since the preview: look at the preview again');
  if (stage.source === 'login' && !(await featureOn(ctx, 'yazio_login.enabled'))) {
    staging.clear(user.id); // what a sign-in fetched is not kept once an admin switched the connector off
    throw new HttpError(404, 'the direct Yazio sign-in is switched off (admin area)');
  }
  if (!staging.begin(user.id)) throw new HttpError(409, 'an upload, preview or import of yours is still running');
  if (!staging.tryHeavy()) {
    staging.end(user.id);
    throw busy('the server is busy with another upload or import, try again in a few seconds');
  }
  try {
    try {
      return [await runImportFrom(ctx.db, user.id, loaded(stage.files), allProducts, dryRun, 'the uploaded files', stage.refresh), stage.token];
    } catch (e) {
      if (e instanceof YazioError) throw new HttpError(422, e.message);
      if (e instanceof SyntaxError || e instanceof RangeError) throw new HttpError(422, 'the files cannot be read');
      throw e;
    }
  } finally {
    staging.releaseHeavy();
    staging.end(user.id);
  }
}

export const routes: Route[] = [
  route('GET', URL, async (req) => {
    const user = await sessionUser(req);
    const { ctx } = req;
    const { stage: staging, runs } = yazioOf(ctx);
    const stage = staging.get(user.id);
    const run = runs.get(user.id);
    const enabled = await featureOn(ctx, 'yazio_login.enabled');
    return {
      stage: stage ? stageView(stage) : null,
      login: { enabled, available: enabled && appIdentity(ctx.env) !== null, run: run ? runView(run) : null, max_months: MAX_MONTHS, default_months: DEFAULT_MONTHS },
      max_file_bytes: MAX_FILE,
    };
  }),

  // One file of the export (days.json, products.json, weight.json; plain or gzip-packed) or `export.zip`. The body is the file itself (at
  // most 24 MB as sent). Files of one series are collected; a ZIP replaces what was there. Nothing is imported yet. The name is checked
  // before the body is read, and only one heavy job runs on the server at a time: another request is answered with 429 at once.
  route('PUT', `${URL}/files/{name}`, async (req) => {
    const user = await sessionUser(req);
    const name = req.params.name!;
    if (!UPLOAD_NAMES.includes(name)) throw new HttpError(422, 'unexpected file name (days.json, products.json, weight.json or a ZIP)');
    if ((req.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/')) throw new HttpError(415, 'send the file itself as the request body, not as a form');
    const { stage: staging } = yazioOf(req.ctx);
    if (!staging.begin(user.id)) throw new HttpError(409, 'an upload, preview or import of yours is still running');
    if (!staging.tryHeavy()) {
      staging.end(user.id);
      throw busy('the server is busy with another upload or import, try again in a few seconds');
    }
    try {
      try {
        const files = await decodeUpload(name, req.raw ?? new Uint8Array());
        return stageView(staging.add(user.id, files, 'upload', name === 'export.zip'));
      } catch (e) {
        if (e instanceof StageError) throw stageHttp(e);
        throw e;
      }
    } finally {
      staging.releaseHeavy();
      staging.end(user.id);
    }
  }),

  // Throw away what is waiting here and cancel a running sign-in fetch.
  route('DELETE', URL, async (req) => {
    const user = await sessionUser(req);
    const { stage, runs } = yazioOf(req.ctx);
    runs.cancel(user.id);
    stage.clear(user.id);
  }, { status: 204 }),

  // What an import would do (counted exactly, nothing written).
  route('POST', `${URL}/preview`, async (req) => {
    await sessionUser(req);
    const body = parse(previewIn, req.body === undefined || req.body === null ? {} : req.body);
    const [summary, token] = await importStaged(req, body.all_products, true, null);
    return previewOf(summary, token);
  }),

  // Import what the preview showed (`token`), as one batch that can be taken back. The staging area is emptied.
  route('POST', `${URL}/confirm`, async (req) => {
    const user = await sessionUser(req);
    const body = parse(confirmIn, req.body);
    const [summary, token] = await importStaged(req, body.all_products, false, body.token);
    yazioOf(req.ctx).stage.clear(user.id, token); // only what was imported, not a newer upload
    return previewOf(summary, token);
  }),

  // Direct one-time sign-in at Yazio (admin switch, off by default; unofficial interface). The server signs in ONCE, fetches the chosen
  // period in the background and forgets e-mail address, password and token; what it fetched goes into the staging area for preview and
  // confirmation. Poll GET /me/yazio for the progress. `months` fetches the whole period once; `days` (1 to 31) is a refresh of the last N days:
  // every day is asked for, and entries and workouts that came from Yazio are updated or removed as Yazio says (Yazio wins; own entries stay).
  route('POST', `${URL}/login`, async (req) => {
    const user = await sessionUser(req);
    const body = parse(loginIn, req.body);
    const { ctx } = req;
    if (!(await featureOn(ctx, 'yazio_login.enabled'))) throw new HttpError(404, 'the direct Yazio sign-in is switched off (admin area)');
    if (appIdentity(ctx.env) === null) throw new HttpError(409, 'the direct Yazio sign-in is not set up (MAHLWERK_YAZIO_CLIENT_ID and MAHLWERK_YAZIO_CLIENT_SECRET)');
    const email = pyStrip(body.email), password = body.password;
    if (!email || !password || pyLen(email) > 200 || pyLen(password) > 500 || email.includes('\n')) throw new HttpError(422, 'e-mail address and password are required');
    if (body.months !== null && body.days !== null) throw new HttpError(422, 'choose either months (the whole period) or days (a refresh of the last days), not both');
    const months = body.months ?? DEFAULT_MONTHS;
    if (!(months >= 1 && months <= MAX_MONTHS)) throw new HttpError(422, `the period is 1 to ${MAX_MONTHS} months`);
    if (body.days !== null && !(body.days >= 1 && body.days <= MAX_REFRESH_DAYS)) throw new HttpError(422, `the refresh period is 1 to ${MAX_REFRESH_DAYS} days`);
    try {
      const run = yazioOf(ctx).runs.start(user.id, new Credentials(email, password), months, body.days);
      // what waits is replaced when the run delivers; clearing here would race with a fast run
      return runView(run);
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      const text = {
        running: 'a fetch of yours is already running', busy: 'the server is busy with other fetches, try again in a few minutes',
        gap: `wait ${e.wait} seconds before the next sign-in attempt`, hourly: 'too many sign-in attempts this hour (at most 3), try again later',
        global: 'too many sign-in attempts on this server this hour, try again later',
      }[e.kind]!;
      throw new HttpError(e.kind === 'running' ? 409 : 429, text);
    }
  }, { status: 202 }),
];
