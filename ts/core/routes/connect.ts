// "Sign in with the browser" for the iPhone app: the app gets its own access key without anybody copying one.
//
// 1. The app opens https://<server>/#/connect?challenge=…&state=…&device=… in the system's sign-in window (ASWebAuthenticationSession).
//    The person signs in the normal way (proxy, passkey, password) and confirms on that page.
// 2. The page calls POST /api/v1/connect/app with the normal sign-in (never a key). That creates NO key yet: only a one-time code that
//    is valid for CODE_SECONDS, bound to the user and to the challenge (PKCE, S256). The page then goes to mahlwerk://connected?code=…
//    (the target is fixed here, never taken from the request).
// 3. The app sends the code as `Authorization: Bearer <code>` with the verifier in the body to POST /api/v1/connect/exchange. The code
//    looks like a key (prefix mw_), so a proxy that lets keys through to /api/v1/ lets this through as well; it is not a key and works on
//    no other route. Only now the key (scope write) is created and returned, once.
// The code alone is worthless (it needs the verifier, which never left the app); it is single-use and lives only in memory, so a
// restart drops the pending ones (the person just tries again).
import { z } from 'zod';
import { bearerToken, configOf, hashToken, newToken, sessionUser } from '../auth.ts';
import { b64url, compareDigest, sha256, utf8 } from '../crypto.ts';
import { featureOn } from '../features.ts';
import { HttpError, parse, route, type Ctx, type Req, type Route } from '../http.ts';
import { pyStr } from '../models/common.ts';
import { createToken, listTokens } from '../store/tokens.ts';

const MAX_ACTIVE = 50; // as in routes/tokens.ts
export const CODE_SECONDS = 60;
const MAX_PENDING = 100; // per server: beyond that a new one is refused (429), nobody else's is dropped
const MAX_PER_USER = 3; // per person: a fourth drops their own oldest
const CODE_PREFIX = 'mw_c'; // still `mw_`: see 3. above
export const CALLBACK = 'mahlwerk://connected';

// `session`: the hash of the sign-in session that confirmed (local, oidc); signing out or a password reset ends it, and the code with it
interface Pending { userId: number; session: string | null; challenge: string; name: string; expires: number }
/** The waiting codes of this server (made on first use): swept when old, dropped when a person's access is revoked. */
function pendingOf(ctx: Ctx): Map<string, Pending> {
  const existing = ctx.services.connectPending as Map<string, Pending> | undefined;
  if (existing) return existing;
  const map = new Map<string, Pending>();
  ctx.services.connectPending = map;
  ((ctx.services.sweepers ??= []) as (() => void)[]).push(() => { const now = ctx.now(); for (const [k, p] of map) if (p.expires <= now) map.delete(k); });
  const ended = ctx.services.userEnded as ((id: number) => Promise<void> | void) | undefined;
  ctx.services.userEnded = async (id: number) => {
    await ended?.(id);
    for (const [k, p] of map) if (p.userId === id) map.delete(k);
  };
  return map;
}

const B64URL_43 = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url without padding (the SHA-256 of the verifier)
const connectIn = z.object({
  challenge: z.string().regex(B64URL_43),
  challenge_method: z.literal('S256'),
  device: z.string().transform((s) => s.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()).pipe(pyStr(1, 60)),
});
// RFC 7636: 43 to 128 characters of [A-Za-z0-9-._~]
const exchangeIn = z.object({ verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/) });

const keyName = (device: string) => `iPhone-App: ${device}`.slice(0, 80);

async function activeKeys(req: Req, userId: number): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  return (await listTokens(req.ctx.db, userId)).filter((t) => t.revoked_at === null && (t.expires_at || now + 1) > now).length;
}

export const routes: Route[] = [
  // Step 2: the signed-in person confirmed on the page. Answers where the page has to go next.
  route('POST', '/api/v1/connect/app', async (req) => {
    const user = await sessionUser(req); // the normal sign-in; a key cannot make keys
    if (!(await featureOn(req.ctx, 'access_tokens.enabled'))) throw new HttpError(404, 'access tokens are switched off');
    const body = parse(connectIn, req.body);
    if ((await activeKeys(req, user.id)) >= MAX_ACTIVE) throw new HttpError(409, `at most ${MAX_ACTIVE} active tokens`);
    const pending = pendingOf(req.ctx);
    const now = req.ctx.now();
    for (const [k, p] of pending) if (p.expires <= now) pending.delete(k);
    const own = [...pending].filter(([, p]) => p.userId === user.id);
    while (own.length >= MAX_PER_USER) pending.delete(own.shift()![0]);
    if (pending.size >= MAX_PENDING) throw new HttpError(429, 'too many sign-ins at the same time, try again in a minute', { 'retry-after': '60' });
    const code = CODE_PREFIX + newToken().slice(3);
    pending.set(await hashToken(code), { userId: user.id, session: user.session_hash ?? null, challenge: body.challenge, name: keyName(body.device), expires: now + CODE_SECONDS });
    return { redirect: `${CALLBACK}?code=${encodeURIComponent(code)}`, expires_in: CODE_SECONDS };
  }),

  // Step 3: the app trades code + verifier for the key. Every failure looks the same and uses the code up.
  route('POST', '/api/v1/connect/exchange', async (req) => {
    const code = bearerToken(req);
    const fail = () => new HttpError(400, 'invalid or expired code');
    if (code === null || !code.startsWith(CODE_PREFIX)) throw fail();
    const pending = pendingOf(req.ctx);
    const key = await hashToken(code);
    const entry = pending.get(key);
    pending.delete(key); // single use, also when what follows fails
    if (entry === undefined || entry.expires <= req.ctx.now()) throw fail();
    const body = exchangeIn.safeParse(req.body);
    if (!body.success) throw fail();
    if (!compareDigest(b64url(await sha256(utf8(body.data.verifier))), entry.challenge)) throw fail();
    // the state of the account and the switch as they are NOW, not as they were a minute ago
    if (!(await featureOn(req.ctx, 'access_tokens.enabled'))) throw new HttpError(404, 'access tokens are switched off');
    // the same accounts as `findToken` accepts keys for: not blocked, not the demo account, in local mode one with a password
    const local = configOf(req.ctx).mode === 'local';
    const user = await req.ctx.db.get<{ id: number; username: string }>(
      "SELECT id, username FROM user WHERE id = ? AND disabled = 0 AND username <> '~demo' AND (? = 0 OR password_hash IS NOT NULL)", [entry.userId, local ? 1 : 0]);
    if (user === undefined) throw fail();
    // the sign-in that confirmed must still be there (signed out, password reset, access revoked: the code is gone too)
    if (entry.session !== null && (await req.ctx.db.get('SELECT 1 FROM auth_session WHERE hash = ? AND user_id = ? AND expires_at > ?', [entry.session, user.id, req.ctx.now()])) === undefined) throw fail();
    if ((await activeKeys(req, user.id)) >= MAX_ACTIVE) throw new HttpError(409, `at most ${MAX_ACTIVE} active tokens`);
    const token = newToken();
    const row = await createToken(req.ctx.db, user.id, entry.name, token.slice(0, 8), await hashToken(token), 'write', null);
    return { token, name: row.name, scope: row.scope, username: user.username };
  }, { auth: false }), // the code names the user; no sign-in is read
];
