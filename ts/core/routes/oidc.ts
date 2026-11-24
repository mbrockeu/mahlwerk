// Sign-in through an OpenID Connect provider (routes/oidc.py): the two browser endpoints of the Authorization Code Flow. In every other
// mode they answer 404. Sign-out is `POST /auth/logout`, shared with the local mode.
//
// Both endpoints are GET and both change state (login stores a pending sign-in, callback signs someone in), so the CSRF header cannot
// protect them: the provider sends the browser back by a plain redirect, which cannot carry it. What protects them instead:
//  * `state` is random and sits in a short-lived HttpOnly cookie of THIS browser (one cookie: state, nonce, PKCE verifier, target and
//    expiry, signed with an HMAC; nothing is kept on the server). The callback needs the cookie AND the same state in the URL. A page
//    that makes a victim's browser open the callback with the attacker's code (login CSRF) fails: the victim's browser has no matching
//    cookie. The code itself works once, which the provider enforces.
//  * `nonce` ties the ID token to this sign-in, the PKCE verifier ties the code to this client.
//  * Starting a sign-in only costs a redirect; nothing happens to an existing session until a valid callback arrives. Both endpoints are
//    limited per address (30 a minute each) so nobody can make the server call the provider without end.
//  * One cookie means one sign-in at a time per browser: starting a second one in another tab replaces the first.
import { z } from 'zod';
import { HOST_PREFIX, authState, configOf, cookieKey, isSecure, startSession } from '../auth.ts';
import { compareDigest } from '../crypto.ts';
import { HttpError, outOf, parse, queryObject, respond, route, type Req, type Route } from '../http.ts';
import { OidcError, newLogin, openLogin, safeNext, sealLogin, type Pending } from '../oidc.ts';
import { cookiesOf, deleteCookieHeader, setCookieHeader } from '../netutil.ts';
import { SignInRefused, oidcSignIn } from '../store/users.ts';
import { addressKey } from './auth.ts';

const COOKIE = 'mahlwerk_oidc';
const KEY_NAME = 'oidc_cookie';
const ERRORS = ['denied', 'failed', 'expired', 'blocked', 'conflict', 'exists', 'name'];

function needOidc(req: Req): void {
  if (configOf(req.ctx).mode !== 'oidc') throw new HttpError(404, 'not available in this sign-in mode');
}

const secure = (req: Req) => isSecure(req, configOf(req.ctx));
/** With Secure the cookie gets the `__Host-` prefix (Path=/, no Domain) and only that name is read. */
const cookieName = (req: Req) => (secure(req) ? HOST_PREFIX + COOKIE : COOKIE);
const dropCookie = (req: Req) => outOf(req).cookies.push(deleteCookieHeader(cookieName(req), secure(req)));

function limit(req: Req, which: 'login' | 'callback'): void {
  const wait = authState(req.ctx).oidcRate[which].allow(addressKey(req));
  if (wait) throw new HttpError(429, 'too many sign-in attempts, try again in a moment', { 'Retry-After': String(wait) });
}

/** Back to the start page with a fixed word the sign-in page turns into a neutral message. The reason goes to the log (no tokens, codes,
 * secrets or claim values in it). The pending-sign-in cookie is always deleted. */
function fail(req: Req, code: string, detail: string) {
  if (!ERRORS.includes(code)) throw new Error('unknown sign-in error code');
  console.warn(`OpenID Connect sign-in failed (${code}): ${detail}`);
  dropCookie(req);
  return respond({ status: 303, headers: { location: configOf(req.ctx).oidc!.home_path + '?auth_error=' + code } });
}

const loginQuery = z.object({ next: z.string().max(400).optional() });
const callbackQuery = z.object({ code: z.string().max(4096).optional(), state: z.string().max(512).optional(), error: z.string().max(200).optional(), iss: z.string().max(2048).optional() });

const REFUSED: Record<string, string> = {
  blocked: 'the account is blocked',
  conflict: 'the user name already belongs to another identity at the provider',
  exists: 'a user of this name exists without a link to the provider (set MAHLWERK_OIDC_LINK_EXISTING=1 to take it over)',
  name: 'the user name is reserved for the demo account',
};

export const routes: Route[] = [
  // Start a sign-in: make state, nonce and PKCE verifier, put them (signed) into a cookie of this browser and send the browser to the
  // provider. `next` (optional) is a path on this site to open afterwards.
  route('GET', '/api/v1/auth/oidc/login', async (req) => {
    needOidc(req);
    const q = parse(loginQuery, queryObject(req.query), 'query');
    limit(req, 'login');
    const { ctx } = req;
    const state = authState(ctx);
    const config = configOf(ctx).oidc!;
    const [st, nonce, verifier, challenge] = await newLogin();
    let url: string;
    try {
      url = await state.oidc!.authorizationUrl(st, nonce, challenge);
    } catch (e) {
      if (e instanceof OidcError) return fail(req, 'failed', e.detail);
      throw e;
    }
    const pending: Pending = { state: st, nonce, verifier, next: safeNext(q.next, config.home_path) };
    // Lax, not Strict: the way back is a top-level navigation coming from the provider, which Strict would not send it with
    outOf(req).cookies.push(setCookieHeader(cookieName(req), await sealLogin(await cookieKey(ctx, KEY_NAME), pending, ctx.now()), { maxAge: 600, secure: secure(req) }));
    return respond({ status: 302, headers: { location: url } });
  }, { auth: false }),

  route('GET', '/api/v1/auth/oidc/callback', async (req) => {
    needOidc(req);
    const q = parse(callbackQuery, queryObject(req.query), 'query');
    limit(req, 'callback');
    const { ctx } = req;
    const config = configOf(ctx).oidc!;
    const client = authState(ctx).oidc!;
    const cookie = cookiesOf(req)[cookieName(req)] ?? '';
    const pending = cookie ? await openLogin(await cookieKey(ctx, KEY_NAME), cookie, ctx.now()) : null;
    if (pending === null) return fail(req, 'expired', 'no valid pending sign-in for this browser (cookie missing, forged, used up or older than 10 minutes)');
    if (!q.state || !compareDigest(q.state, pending.state)) return fail(req, 'failed', 'state differs');
    let user;
    try {
      const doc = await client.discovery();
      // RFC 9207: an answer that names another issuer is refused; when the provider says it always sends `iss`, it is required
      if ((q.iss !== undefined && q.iss !== doc.issuer) || (q.iss === undefined && doc.authorization_response_iss_parameter_supported === true)) {
        throw new OidcError('failed', 'iss parameter missing or differs from the issuer');
      }
      if (q.error !== undefined) throw new OidcError('denied', 'the provider answered with error ' + [...q.error.slice(0, 40)].filter((c) => /[\p{L}\p{N}_-]/u.test(c)).join(''));
      if (!q.code) throw new OidcError('failed', 'no code in the answer');
      const who = await client.identity(q.code, pending.verifier, pending.nonce);
      user = await oidcSignIn(ctx.db, who.issuer, who.sub, who.username, who.display_name, who.admin, config.link_existing, who.household);
    } catch (e) {
      if (e instanceof OidcError) return fail(req, e.code, e.detail);
      if (e instanceof SignInRefused) return fail(req, e.code, REFUSED[e.code]!);
      throw e;
    }
    dropCookie(req);
    await startSession(req, user.id);
    return respond({ status: 303, headers: { location: pending.next } });
  }, { auth: false }),
];
