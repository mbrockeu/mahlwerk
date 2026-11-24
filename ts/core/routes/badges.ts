// Badges (routes/badges.py): what the person has earned, what is still open, and what they have already been shown.
import { overview } from '../badges.ts';
import { parse, route, type Req, type Route } from '../http.ts';
import { badgesSeenIn } from '../models/body.ts';
import { badgesEarned, markBadgesSeen } from '../store/badges.ts';
import { goalTimeline } from '../store/goals.ts';
import { getSettings } from '../store/settings.ts';
import { emit } from '../webhooks.ts';

const EMPTY = () => ({ earned: [], open: [], new: [] });

async function playful(req: Req): Promise<boolean> {
  const settings = await getSettings(req.ctx.db, req.user!.id);
  return Object.hasOwn(settings, 'playful') ? Boolean(settings.playful) : true;
}

/** Bring the badges up to date; every badge reached by this call is announced to the user's webhooks. */
async function current(req: Req) {
  const { db } = req.ctx;
  const user = req.user!;
  const before = new Set((await badgesEarned(db, user.id)).map((b) => b.code));
  const result = await overview(db, user.id, await goalTimeline(db, user.id), Math.floor(Date.now() / 1000));
  for (const item of result.earned) if (!before.has(item.code)) emit(req, user, 'badge.earned', { code: item.code, earned_at: item.earned_at });
  return result;
}

export const routes: Route[] = [
  route('GET', '/api/v1/badges', async (req) => ((await playful(req)) ? current(req) : EMPTY())),
  route('POST', '/api/v1/badges/seen', async (req) => {
    const body = parse(badgesSeenIn, req.body);
    if (!(await playful(req))) return EMPTY();
    await markBadgesSeen(req.ctx.db, req.user!.id, body.codes);
    return current(req);
  }),
];
