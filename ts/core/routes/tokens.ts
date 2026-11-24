// Personal access tokens: create, list and revoke your own (routes/tokens.py). Managing them needs the normal sign-in, never a token.
import { z } from 'zod';
import { hashToken, newToken, sessionUser } from '../auth.ts';
import { featureOn } from '../features.ts';
import { HttpError, parse, pathInt, route, type Req, type Route } from '../http.ts';
import { nullish, pyInt, pyStr } from '../models/common.ts';
import { createToken, listTokens, revokeToken } from '../store/tokens.ts';

const MAX_ACTIVE = 50;

const tokenIn = z.object({
  name: z.string().transform((s) => s.trim()).pipe(pyStr(1, 80)),
  scope: z.enum(['read', 'write']),
  expires_in_days: nullish(pyInt().pipe(z.number().min(1).max(3650))),
});

/** The dependencies of the router: the normal sign-in, then the switch (404 while access tokens are off). */
async function guard(req: Req) {
  const user = await sessionUser(req);
  if (!(await featureOn(req.ctx, 'access_tokens.enabled'))) throw new HttpError(404, 'access tokens are switched off');
  return user;
}

export const routes: Route[] = [
  // The tokens of this user, newest first, with their state; never the secret.
  route('GET', '/api/v1/me/tokens', async (req) => listTokens(req.ctx.db, (await guard(req)).id)),

  // Create a token. The clear text is in this response and nowhere else; only its SHA-256 is stored.
  route('POST', '/api/v1/me/tokens', async (req) => {
    const user = await guard(req);
    const body = parse(tokenIn, req.body);
    const now = Math.floor(Date.now() / 1000);
    const active = (await listTokens(req.ctx.db, user.id)).filter((t) => t.revoked_at === null && (t.expires_at || now + 1) > now);
    if (active.length >= MAX_ACTIVE) throw new HttpError(409, `at most ${MAX_ACTIVE} active tokens`);
    const token = newToken();
    const expires = body.expires_in_days ? now + body.expires_in_days * 86400 : null;
    const row = await createToken(req.ctx.db, user.id, body.name, token.slice(0, 8), await hashToken(token), body.scope, expires);
    return { ...row, token };
  }, { status: 201 }),

  // Revoke a token at once. The entry stays in the list as revoked.
  route('DELETE', '/api/v1/me/tokens/{token_id}', async (req) => {
    const user = await guard(req);
    const id = pathInt(req, 'token_id');
    if (!(await revokeToken(req.ctx.db, user.id, id))) throw new HttpError(404, 'unknown token');
    return undefined;
  }, { status: 204 }),
];
