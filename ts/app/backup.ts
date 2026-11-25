// The iCloud file backup of the app (the native side keeps the files in the app's iCloud folder; see ts/PORTING.md "App-Host"):
// three routes that exist only in the app host, never in the server, reached through window.mahlwerkHost.request.
// - GET  /api/v1/me/backup          -> {filename, zip_base64, counts, empty}: the same ZIP as GET /me/export (format 2, everything)
// - GET  /api/v1/me/backup/state    -> {empty}: true for a fresh database (asked at every start, so it is cheap)
// - POST /api/v1/me/backup/restore  {zip_base64} -> like "replace" of the import, as one transaction; 422 for a broken file
// The body is text on the native side, hence base64. Stored secrets (the Cookidoo account) are never part of an export.
import { z } from 'zod';
import { sessionUser } from '../core/auth.ts';
import { decodeImport, modesAllowed, ownCounts, parseExport, runImport } from '../core/dataImport.ts';
import { today } from '../core/dates.ts';
import { buildExport, fileName } from '../core/export.ts';
import type { Db } from '../core/db.ts';
import { HttpError, parse, route, type Route } from '../core/http.ts';
import { heavy, REASONS } from '../core/routes/dataImport.ts';
import { setSetting } from '../core/store/settings.ts';
import { fromB64, toB64 } from './bridge.ts';

const restoreIn = z.object({ zip_base64: z.string().min(1) });

async function isEmpty(db: Db, userId: number): Promise<boolean> {
  const row = await db.get(`SELECT
      EXISTS (SELECT 1 FROM diary_entry WHERE user_id = ?) OR EXISTS (SELECT 1 FROM weight WHERE user_id = ?)
      OR EXISTS (SELECT 1 FROM template WHERE user_id = ?) OR EXISTS (SELECT 1 FROM recipe WHERE created_by = ?)
      OR EXISTS (SELECT 1 FROM goal WHERE user_id = ?) AS has`, [userId, userId, userId, userId, userId]);
  return !row?.has;
}

export const BACKUP_ROUTES: Route[] = [
  route('GET', '/api/v1/me/backup', async (req) => {
    const user = await sessionUser(req);
    const zip = await buildExport(req.ctx.db, user, null, null, 'de', req.ctx.now());
    return { filename: fileName(user.username, today()), zip_base64: toB64(zip), counts: await ownCounts(req.ctx.db, user.id), empty: await isEmpty(req.ctx.db, user.id) };
  }),

  route('GET', '/api/v1/me/backup/state', async (req) => {
    const user = await sessionUser(req);
    return { empty: await isEmpty(req.ctx.db, user.id) };
  }),

  route('POST', '/api/v1/me/backup/restore', async (req) => {
    const user = await sessionUser(req);
    const body = parse(restoreIn, req.body);
    let bytes: Uint8Array;
    try { bytes = fromB64(body.zip_base64); } catch { throw new HttpError(422, 'the backup is not valid base64'); }
    return heavy(req, user.id, async () => {
      const file = parseExport(await decodeImport(bytes));
      const result = await req.ctx.db.tx(async (tx) => {
        const reason = modesAllowed(file, await ownCounts(tx, user.id)).replace;
        if (reason) throw new HttpError(422, REASONS.replace[reason]!);
        const done = await runImport(tx, user, file, 'replace', true, req.ctx.now());
        // whoever restores a backup is no new user: the introduction tour does not start again (a backup made before the tour
        // was seen, or the demo file, carries no tour_seen)
        await setSetting(tx, user.id, 'tour_seen', true);
        return done;
      });
      return { replaced: true, imported: result.counts, deleted: result.deleted };
    });
  }),
];
