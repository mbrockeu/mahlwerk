// Personal data export (routes/export.py): the signed-in user downloads everything of their own.
import { z } from 'zod';
import { today } from '../dates.ts';
import { buildExport, fileName } from '../export.ts';
import { HttpError, parse, queryObject, respond, route, type Req, type Route } from '../http.ts';
import { parseDay } from './diary.ts';

/** The language is kept on the device, not in the account: the interface sends it as `lang`, else the browser's counts. */
function language(req: Req, lang: string | undefined): string {
  if (lang) return lang;
  const first = (req.headers['accept-language'] ?? '').split(',')[0].trim().toLowerCase();
  return first.startsWith('de') ? 'de' : 'en';
}

export const routes: Route[] = [
  // A ZIP with diary.csv, weight.csv, activity.csv, workouts.csv, water.csv, fasting.csv and the complete mahlwerk-export.json of
  // the caller's own data. `from`/`to` limit the day-based data.
  route('GET', '/api/v1/me/export', async (req) => {
    const { from, to, lang } = parse(z.object({ from: z.string().optional(), to: z.string().optional(), lang: z.enum(['de', 'en']).optional() }), queryObject(req.query), 'query');
    const start = from ? parseDay(from) : null;
    const end = to ? parseDay(to) : null;
    if (start && end && start > end) throw new HttpError(422, 'from must not be after to');
    const user = req.user!;
    const body = await buildExport(req.ctx.db, user, start, end, language(req, lang), Date.now() / 1000);
    return respond({
      body, headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${fileName(user.username, today())}"` },
    });
  }),
];
