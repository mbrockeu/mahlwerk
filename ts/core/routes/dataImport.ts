// Import of an own data export (dataImport.ts): upload the file and look at the preview, then confirm with the preview's token and a
// mode ("merge" or "replace"). Only for the signed-in person themself (an access token is refused), only into their own account, closed
// for the demo account (demoAccount.ts). TS only: the Python server has no such route; the interface asks GET /me/import (404 there).
// (Not a key in GET /me `features`: the Python API tests compare that object exactly, and both servers must keep answering them.)
import { z } from 'zod';
import { sessionUser } from '../auth.ts';
import { decodeImport, FORMATS, ImportError, MAX_JSON, ImportStage, modesAllowed, ownCounts, parseExport, runImport, type ExportFile, type Mode } from '../dataImport.ts';
import { HttpError, parse, route, type Ctx, type Req, type Route } from '../http.ts';
import { limitFor } from '../security.ts';
import { pyStr } from '../models/common.ts';
import { StageError } from '../yazioStage.ts';
import { yazioOf } from './yazio.ts';

const URL = '/api/v1/me/import';

/** The waiting files of this app (made on first use); what waits is dropped when a session ends. */
export function importOf(ctx: Ctx): ImportStage {
  const existing = ctx.services.dataImport as ImportStage | undefined;
  if (existing) return existing;
  const stage = new ImportStage(() => ctx.now());
  ctx.services.dataImport = stage;
  const ended = ctx.services.userEnded as ((id: number) => Promise<void> | void) | undefined;
  ctx.services.userEnded = async (id: number) => {
    await ended?.(id);
    stage.clear(id);
  };
  return stage;
}

const stageHttp = (e: StageError) => new HttpError(({ too_large: 413, busy: 503 } as Record<string, number>)[e.code] ?? 422, e.text);
const busy = () => new HttpError(429, 'the server is busy with another upload or import, try again in a few seconds', { 'retry-after': '3' });
const confirmIn = z.object({ token: pyStr(1, 64), mode: z.enum(['merge', 'replace']).default('merge') });

/** One heavy job at a time on the whole server, shared with the Yazio import; one preview or import per person. */
async function heavy<T>(req: Req, userId: number, fn: () => Promise<T>): Promise<T> {
  const stage = importOf(req.ctx);
  if (!stage.begin(userId)) throw new HttpError(409, 'an upload, preview or import of yours is still running');
  const lock = yazioOf(req.ctx).stage;
  if (!lock.tryHeavy()) {
    stage.end(userId);
    throw busy();
  }
  try {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof StageError) throw stageHttp(e);
      if (e instanceof ImportError) throw new HttpError(422, e.message);
      throw e;
    }
  } finally {
    lock.releaseHeavy();
    stage.end(userId);
  }
}

const REASONS: Record<Mode, Record<string, string>> = {
  merge: { old_format: 'this file is from before stable ids (format 1): merging would double what is here. Replace, or import into an account without data' },
  replace: { ranged: 'this file holds only the days of a period: replacing would delete everything else. Export everything (no period) to replace' },
};

async function preview(req: Req, file: ExportFile, token: string) {
  const user = req.user!;
  const { db } = req.ctx;
  const own = await ownCounts(db, user.id);
  const allowed = modesAllowed(file, own);
  const now = req.ctx.now();
  const modes: Record<string, unknown> = {};
  const warnings: Record<string, number> = {};
  for (const mode of ['merge', 'replace'] as const) {
    const reason = allowed[mode];
    if (reason) { modes[mode] = { allowed: false, reason, reason_text: REASONS[mode][reason], counts: null, deleted: null }; continue; }
    const result = await runImport(db, user, file, mode, false, now);
    Object.assign(warnings, result.warnings);
    modes[mode] = { allowed: true, reason: null, reason_text: null, counts: result.counts, deleted: result.deleted };
  }
  if (file.format_version < 2) warnings.old_format = 1;
  if (file.range?.from || file.range?.to) warnings.ranged = 1;
  return {
    token, format_version: file.format_version, exported_at: file.exported_at ?? null, app_version: file.app_version ?? null,
    account: { username: file.account?.username ?? null, display_name: file.account?.display_name ?? null },
    same_account: file.account?.username === user.username,
    range: { from: file.range?.from ?? null, to: file.range?.to ?? null },
    mode_allowed: (['merge', 'replace'] as const).filter((m) => !allowed[m]),
    modes,
    warnings: Object.entries(warnings).sort(([a], [b]) => (a < b ? -1 : 1)).map(([code, count]) => ({ code, count })),
  };
}

export const routes: Route[] = [
  // Whether this server (or the app) takes an own export back in, and how large the file may be: the interface shows the import only then.
  route('GET', URL, async (req) => {
    await sessionUser(req);
    return { available: true, max_bytes: limitFor(`${URL}/preview`), max_unpacked_bytes: MAX_JSON, formats: FORMATS };
  }),

  // The body is the file itself: the ZIP of GET /me/export or its mahlwerk-export.json (at most 32 MB as sent, 48 MB unpacked). Nothing
  // is written; the file waits 20 minutes for the confirmation. The preview counts per kind what merge and replace would do.
  route('POST', `${URL}/preview`, async (req) => {
    const user = await sessionUser(req);
    if ((req.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/')) throw new HttpError(415, 'send the file itself as the request body, not as a form');
    return heavy(req, user.id, async () => {
      const json = await decodeImport(req.raw ?? new Uint8Array());
      const file = parseExport(json);
      const staged = importOf(req.ctx).put(user.id, json);
      return preview(req, file, staged.token);
    });
  }),

  // Import what the preview showed (`token`) in the chosen mode, as one transaction. The waiting file is dropped afterwards.
  route('POST', `${URL}/confirm`, async (req) => {
    const user = await sessionUser(req);
    const body = parse(confirmIn, req.body);
    const stage = importOf(req.ctx);
    const staged = stage.get(user.id);
    if (!staged) throw new HttpError(410, 'nothing is waiting to be imported (it may have expired): choose the file again');
    if (staged.token !== body.token) throw new HttpError(409, 'the file changed since the preview: look at the preview again');
    return heavy(req, user.id, async () => {
      const file = parseExport(staged.json);
      const { db } = req.ctx;
      const result = await db.tx(async (tx) => {
        const reason = modesAllowed(file, await ownCounts(tx, user.id))[body.mode];
        if (reason) throw new HttpError(409, REASONS[body.mode][reason]!);
        return runImport(tx, user, file, body.mode, true, req.ctx.now());
      });
      stage.clear(user.id, staged.token);
      return { mode: body.mode, counts: result.counts, deleted: result.deleted, warnings: Object.entries(result.warnings).map(([code, count]) => ({ code, count })) };
    });
  }),

  // Throw away the waiting file.
  route('DELETE', `${URL}/staged`, async (req) => {
    const user = await sessionUser(req);
    importOf(req.ctx).clear(user.id);
  }, { status: 204 }),
];
