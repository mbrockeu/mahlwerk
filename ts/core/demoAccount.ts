// The built-in demo account (demo_account.py): one invented user per installation that an ADMIN can switch to, so that the real
// account holds only real entries while the whole app can still be tried and shown with full sample data. Nobody can sign in as
// it, and only a signed-in admin gets there. The switch is a second cookie, HMAC-signed with a key kept in the table `setting`.
//
// What a demo request may do is decided by ONE table (`POLICY`) that every route of the app must appear in. Unknown routes are
// closed too (fail closed). The keys are the route templates of the Python server (`GET /api/v1/foods/{food_id}`): routes of other
// packages must use the same templates, or they are closed in the demo view.
import { b64url, compareDigest, hmacSha256, unb64url, utf8 } from './crypto.ts';
import { generate } from './demo.ts';
import type { Db } from './db.ts';
import { HttpError, type Req, type User } from './http.ts';
import { RESERVED_USERNAME, createDemoUser, demoAccountReady, eraseUserData } from './store/demo.ts';
import { NameTaken } from './store/users.ts';

export const COOKIE = 'mahlwerk_demo';
export const KEY_NAME = 'demo_view_cookie';
export const TTL = 12 * 3600; // how long a switch lasts at most where the sign-in is a session (local, oidc): also tied to that session
export const TTL_UNBOUND = 2 * 3600; // single and proxy mode have no session to tie it to: shorter
export const VIEW_HEADER = 'X-Mahlwerk-View'; // `own` or `demo`: what the interface believes it is looking at (requests) and what the server says (answers)
export const VIEW_CHANGED = 'view changed';
const DAYS = 90; // how much sample history is made
const READ_METHODS = ['GET', 'HEAD'];
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
export const BLOCKED_MESSAGE = 'not available in the demo account';

/** "read": a GET the demo account may do; "own": a write on the user's own data; "blocked": closed to demo requests; "public": no
 * identity is involved. */
export const POLICY = new Map<string, string>();

function classify(kind: string, ...routes: string[]): void {
  for (const route of routes) {
    const [method, path] = [route.slice(0, route.indexOf(' ')), route.slice(route.indexOf(' ') + 1)];
    const key = `${method} /api/v1${path}`;
    if (POLICY.has(key)) throw new Error(`demo policy: ${route} twice`);
    POLICY.set(key, kind);
  }
}

// no demo identity is involved: the switch itself works with the REAL identity and never as the demo account
classify('public', 'POST /auth/setup', 'POST /auth/login', 'POST /auth/logout', 'GET /auth/oidc/login', 'GET /auth/oidc/callback',
  'POST /me/demo-view/enter', 'POST /me/demo-view/leave');
classify('read',
  'GET /auth/status', 'GET /me', 'GET /me/goal/history', 'GET /me/imports', 'GET /weights', 'GET /catalog', 'GET /foods', 'GET /foods/recent', 'GET /foods/combos', 'GET /foods/{food_id}',
  'GET /diary/{day}', 'GET /history', 'GET /insights', 'GET /insights/nutrient', 'GET /insights/foods', 'GET /insights/foods/detail',
  'GET /review', 'GET /nutrients', 'GET /templates', 'GET /recipes/suggestions', 'GET /recipes', 'GET /recipes/{recipe_id}',
  'GET /recipe-groups', 'GET /badges', 'GET /fasting', 'GET /summary/today', 'GET /activity', 'GET /images/{digest}/{size}',
  'GET /me/export'); // the demo account's own sample data, nothing else
classify('own', // these write only rows of the signed-in user, which for a demo request is the demo account
  'PATCH /me/settings', 'PUT /me/goal', 'PUT /weights/{day}', 'DELETE /weights/{day}',
  'POST /diary/{day}/entries', 'POST /diary/{day}/copy', 'PATCH /diary/entries/{entry_id}', 'DELETE /diary/entries/{entry_id}',
  'POST /templates', 'PATCH /templates/{template_id}', 'DELETE /templates/{template_id}', 'POST /templates/{template_id}/apply',
  'POST /badges/seen', 'POST /water/{day}', 'PUT /water/{day}',
  'POST /fasting/start', 'POST /fasting/stop', 'PATCH /fasting/{fast_id}', 'DELETE /fasting/{fast_id}',
  'PUT /activity/{day}', 'POST /workouts', 'PATCH /workouts/{workout_id}', 'DELETE /workouts/{workout_id}', 'POST /health/sync',
  'POST /recipes/ingredients/match', // reads a pasted ingredient list and looks up foods; writes nothing
  'POST /label-scans'); // reads a photo; writes nothing for the demo account
classify('blocked',
  // the account itself: no name change, no password, no own test data, no accounts
  'PATCH /me', 'POST /me/demo-data', 'DELETE /me/demo-data', 'POST /auth/password',
  'POST /admin/users', 'PATCH /admin/users/{username}', 'POST /admin/users/{username}/password', 'POST /admin/users/{username}/revoke-access',
  // shared products, recipes, groups and pictures: the household's, read and book yes, change no
  'GET /foods/barcode/{code}', // a lookup stores the product it finds (and asks Open Food Facts)
  'PUT /foods/barcode/{code}', 'POST /foods', 'PUT /foods/{food_id}', 'DELETE /foods/{food_id}', 'POST /catalog/adopt',
  'POST /recipes', 'PUT /recipes/{recipe_id}', 'DELETE /recipes/{recipe_id}',
  'POST /recipe-groups', 'PUT /recipe-groups/order', 'PUT /recipe-groups/foods/{food_id}', 'PUT /recipe-groups/{group_id}',
  'DELETE /recipe-groups/{group_id}', 'POST /recipe-groups/{group_id}/members', 'POST /recipe-groups/{group_id}/members/remove',
  'PUT /foods/{food_id}/image', 'DELETE /foods/{food_id}/image', 'POST /foods/{food_id}/image/restore',
  'PUT /foods/{food_id}/piece', 'DELETE /foods/{food_id}/piece', 'PUT /foods/{food_id}/drink',
  // what reaches outwards or lets something in: keys, webhooks, connectors, imports
  'GET /me/tokens', 'POST /me/tokens', 'DELETE /me/tokens/{token_id}',
  'GET /me/webhooks', 'POST /me/webhooks', 'PATCH /me/webhooks/{hook_id}', 'DELETE /me/webhooks/{hook_id}',
  'POST /me/webhooks/{hook_id}/test', 'GET /me/webhooks/{hook_id}/deliveries',
  'DELETE /me/imports/{import_id}',
  'GET /cookidoo/status', 'GET /cookidoo/week', 'GET /cookidoo/collections', 'GET /cookidoo/recipe', 'POST /cookidoo/adopt',
  'GET /cookidoo/import/preview', 'POST /cookidoo/import', 'GET /cookidoo/import', 'GET /cookidoo/images/preview',
  'POST /cookidoo/images', 'DELETE /cookidoo/import',
  'POST /web-recipes/preview', 'POST /web-recipes', 'POST /web-recipes/{food_id}/reload',
  'GET /me/yazio', 'PUT /me/yazio/files/{name}', 'DELETE /me/yazio', 'POST /me/yazio/preview', 'POST /me/yazio/confirm', 'POST /me/yazio/login',
  'GET /me/cookidoo-account', 'PUT /me/cookidoo-account', 'DELETE /me/cookidoo-account', 'POST /me/cookidoo-account/check',
  // the admin area (also closed by is_admin = false; listed so that the table is complete)
  'GET /admin/overview', 'GET /admin/users', 'GET /admin/connectors', 'PATCH /admin/connectors/{key}',
  'GET /admin/catalog/refresh', 'POST /admin/catalog/refresh',
  'GET /admin/cookidoo/account', 'PUT /admin/cookidoo/account', 'DELETE /admin/cookidoo/account', 'POST /admin/cookidoo/account/check',
  'GET /vision/status', 'POST /vision/meal', 'POST /vision/recipe', // photos would go to a model the operator pays for
  'POST /admin/demo-account/reset', 'DELETE /admin/demo-account');

export const verdict = (method: string, path: string): string | undefined => POLICY.get(`${method.toUpperCase()} ${path}`);

/** The interface says which account it shows (header `X-Mahlwerk-View`); a WRITE for another one is refused before it runs, so that
 * a tab that did not notice a switch cannot book into the wrong diary. Without the header a write is accepted as before, except as
 * the demo account: a demo write must say `demo`. Reads are never refused; access keys carry no view. */
export function checkView(req: Req, actual: string, viaToken: boolean): void {
  if (viaToken || !WRITE_METHODS.includes(req.method)) return;
  const claimed = req.headers[VIEW_HEADER.toLowerCase()];
  if (claimed === undefined && actual === 'own') return;
  if (claimed !== actual) throw new HttpError(409, VIEW_CHANGED, { [VIEW_HEADER]: actual });
}

/** Refuse (403) what a demo request may not do. Fails closed: a route that is not in the table is closed. */
export function enforce(req: Req, _user: User): void {
  const kind = verdict(req.method, req.route ?? '');
  const read = READ_METHODS.includes(req.method);
  if ((kind === 'read' || kind === 'public') && read) return;
  if (kind === 'own' && !read) return;
  throw new HttpError(403, BLOCKED_MESSAGE, { [VIEW_HEADER]: 'demo' });
}

// --- the switch cookie ---------------------------------------------------------------------------------------------------

const mac = async (key: Uint8Array, body: string): Promise<string> => b64url(await hmacSha256(key, utf8(body)));

/** What ties the cookie to the real sign-in session (empty where there is none: single and proxy mode). */
export async function bind(key: Uint8Array, sessionHash: string | null | undefined): Promise<string> {
  if (!sessionHash) return '';
  const digest = await hmacSha256(key, utf8('session:' + sessionHash));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export async function seal(key: Uint8Array, realUserId: number, sessionHash: string | null | undefined, now: number): Promise<string> {
  const ttl = sessionHash ? TTL : TTL_UNBOUND;
  const body = b64url(utf8(JSON.stringify({ u: realUserId, s: await bind(key, sessionHash), e: Math.trunc(now) + ttl })));
  return body + '.' + (await mac(key, body));
}

/** Whether the cookie value is a genuine, unexpired switch of THIS real user (and session). */
export async function openCookie(key: Uint8Array, value: string, realUserId: number, sessionHash: string | null | undefined, now: number): Promise<boolean> {
  const dot = value.indexOf('.');
  const body = dot < 0 ? value : value.slice(0, dot);
  const tag = dot < 0 ? '' : value.slice(dot + 1);
  if (!body || !tag || value.length > 1000) return false;
  if (!compareDigest(tag, await mac(key, body))) return false;
  try {
    const raw = unb64url(body);
    if (raw === null) return false;
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return false;
    const { u, e, s } = data as Record<string, unknown>;
    return u === realUserId && typeof e === 'number' && e > now && typeof s === 'string' && compareDigest(s, await bind(key, sessionHash));
  } catch { return false; }
}

// --- making, filling, resetting and deleting the account ----------------------------------------------------------------------

/** `code`: `exists` (a real user has the reserved name) or `missing`. */
export class DemoAccountError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

/** Sample data up to today for the demo account (the days that are there stay), and the settings that fit it. */
async function fill(db: Db, userId: number, today: string) {
  const result = await generate(db, userId, today, DAYS, 'demo_account');
  await db.run('INSERT INTO user_setting (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value', [userId, 'tour_seen', 'true']); // the first-run tour would otherwise start again at every switch
  return result;
}

/** Make the demo account if it is not there (idempotent), fill it up to today, return its id. Never takes over a real user. */
export async function provision(db: Db, today: string): Promise<number> {
  let userId: number;
  try {
    [userId] = await createDemoUser(db);
  } catch (e) {
    if (e instanceof NameTaken) throw new DemoAccountError('exists', `a user named '${RESERVED_USERNAME}' already exists: the name is reserved for the demo account, so it cannot be switched on`);
    throw e;
  }
  await fill(db, userId, today);
  return userId;
}

/** Back to a fresh start: everything the demo account holds goes, new sample data up to today is made. */
export async function reset(db: Db, today: string): Promise<number> {
  const userId = await demoAccountReady(db);
  if (userId === null) throw new DemoAccountError('missing', 'there is no demo account');
  await eraseUserData(db, userId);
  await fill(db, userId, today);
  return userId;
}

/** Empty the account and mark it deleted (the row stays); the switch to it ends at once. */
export async function remove(db: Db): Promise<boolean> {
  const userId = await demoAccountReady(db);
  if (userId === null) return false;
  await eraseUserData(db, userId, true);
  return true;
}
