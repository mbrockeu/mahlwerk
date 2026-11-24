// Who is calling (auth.py): one fixed user (single), the user a trusted reverse proxy has authenticated (proxy), an account of this
// server signed in with a password and a session cookie (local), or a user the OpenID Connect provider has signed in, who then holds
// the same kind of session cookie (oidc). An access token (`mw_...`) works in every mode.
//
// An admin who has switched to the built-in demo account (see demoAccount.ts) is still signed in as themself; `currentUser` then
// hands the demo user to the routes (`is_demo`), `identity` and `realUser` always say who really is there.
import * as demoAccount from './demoAccount.ts';
import { sha256Hex, tokenUrlsafe } from './crypto.ts';
import { featureOn } from './features.ts';
import { HttpError, outOf, type Ctx, type Req, type User } from './http.ts';
import { cookiesOf, deleteCookieHeader, parseIp, setCookieHeader, ipKey, type Ip } from './netutil.ts';
import { OidcClient, RateLimit, oidcConfigFromEnv, type OidcConfig } from './oidc.ts';
import { PasswordHasher } from './passwords.ts';
import { secretKey } from './store/globals.ts';
import { createSession, deleteSession, findSession, getOrCreateUser, isReservedName, ownName } from './store/users.ts';
import { findToken, touchToken } from './store/tokens.ts';
import { RESERVED_USERNAME, demoAccountReady } from './store/demo.ts';
import { LoginThrottle } from './throttle.ts';
import { urlsplit } from './urlsplit.ts';

export const TOKEN_PREFIX = 'mw_';
const READ_METHODS = ['GET', 'HEAD'];
// POST routes that only read (the text is too long for a query string): a read access key may call them
const READ_ONLY_POSTS = ['/api/v1/recipes/ingredients/match'];
export const SESSION_COOKIE = 'mahlwerk_session';
export const HOST_PREFIX = '__Host-'; // the browser then insists on Secure, Path=/ and no Domain: no sibling site can plant or overwrite it
const OIDC_SESSION_DAYS = 7; // the oidc mode asks the provider again after a week of silence
const OIDC_SESSION_MAX_DAYS = 30;
const SESSION_DAYS = 30;
const SESSION_TTL = SESSION_DAYS * 86400;
const SESSION_MAX_AGE = 180 * 86400; // absolute: a session never lives longer than this, however often it is used
export const BLOCKED = 'this account is blocked: ask an admin of this server';
const MODES = ['single', 'proxy', 'local', 'oidc'];
export const SESSION_MODES = ['local', 'oidc']; // the modes whose sign-in is a session cookie
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** A Host header or a configured host as a bare lower-case name: port removed, IPv6 in brackets. */
export function normalizeHost(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.startsWith('[')) return v.includes(']') ? v.slice(0, v.indexOf(']') + 1) : v;
  if (v.split(':').length - 1 > 1) return `[${v}]`; // a bare IPv6 address in the configuration
  return v.includes(':') ? v.slice(0, v.lastIndexOf(':')) : v;
}

/** MAHLWERK_ALLOWED_HOSTS (comma separated, `*` = any). Unset: only loopback names in `single` mode (no login, so a rebinding page
 * could otherwise reach everything); in `oidc` mode the host of MAHLWERK_PUBLIC_URL plus the loopback names; no check in `proxy`
 * and `local` (document: set it). */
export function allowedHosts(env: Record<string, string | undefined>, mode: string, publicHost: string | null = null): Set<string> | null {
  const raw = (env.MAHLWERK_ALLOWED_HOSTS ?? '').trim();
  if (!raw) {
    if (mode === 'oidc' && publicHost) return new Set([...LOOPBACK_HOSTS, normalizeHost(publicHost)]);
    return mode === 'single' ? new Set(LOOPBACK_HOSTS) : null;
  }
  const names = raw.split(',').filter((p) => p.trim()).map(normalizeHost);
  return names.includes('*') ? null : new Set(names);
}

export interface AuthConfig {
  mode: string;
  single_user: string;
  user_header: string;
  name_header: string;
  groups_header: string;
  admin_group: string;
  // Groups whose members belong to the household (proxy and oidc mode); the others are guests. null = everybody is household. The
  // admin group always counts.
  household_groups: Set<string> | null;
  trusted: Set<string>; // ipKey of each trusted proxy address
  cookie_secure: boolean;
  // Host names this server answers to (null = any). Against DNS rebinding.
  allowed_hosts: Set<string> | null;
  // sliding lifetime of a session and the absolute limit (local and oidc mode)
  session_ttl: number;
  session_max_age: number;
  oidc: OidcConfig | null;
}

function days(env: Record<string, string | undefined>, name: string, dflt: number): number {
  const raw = (env[name] ?? '').trim();
  if (!raw) return dflt;
  const value = /^[+-]?\d+$/.test(raw) ? Number(raw) : 0;
  if (!(value >= 1 && value <= 3650)) throw new Error(`${name} must be a whole number of days from 1 to 3650`);
  return value;
}

export function authConfigFromEnv(env: Record<string, string | undefined>): AuthConfig {
  const mode = (env.MAHLWERK_AUTH ?? 'single').trim().toLowerCase();
  if (!MODES.includes(mode)) throw new Error(`MAHLWERK_AUTH must be 'single', 'proxy', 'local' or 'oidc', not '${mode}'`);
  const trusted = new Set<string>();
  for (const part of (env.MAHLWERK_TRUSTED_PROXIES ?? '').split(',')) {
    if (!part.trim()) continue;
    const ip = parseIp(part.trim());
    if (!ip) throw new Error(`'${part.trim()}' does not appear to be an IPv4 or IPv6 address`);
    trusted.add(ipKey(ip));
  }
  const adminGroup = (env.MAHLWERK_ADMIN_GROUP ?? 'admin').trim() || 'admin';
  const rawHousehold = (env.MAHLWERK_HOUSEHOLD_GROUPS ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const householdGroups = rawHousehold.length ? new Set([...rawHousehold, adminGroup]) : null;
  const singleUser = env.MAHLWERK_SINGLE_USER ?? 'me';
  if (mode === 'single' && isReservedName(singleUser)) throw new Error(`MAHLWERK_SINGLE_USER must not be '${RESERVED_USERNAME}': that name is reserved for the demo account`);
  const oidc = mode === 'oidc' ? oidcConfigFromEnv(env, adminGroup, householdGroups) : null;
  const oidcMode = mode === 'oidc';
  const d = days(env, 'MAHLWERK_SESSION_DAYS', oidcMode ? OIDC_SESSION_DAYS : SESSION_DAYS);
  const maxDays = Math.max(d, days(env, 'MAHLWERK_SESSION_MAX_DAYS', oidcMode ? OIDC_SESSION_MAX_DAYS : SESSION_MAX_AGE / 86400));
  return {
    mode, session_ttl: d * 86400, session_max_age: maxDays * 86400, oidc,
    allowed_hosts: allowedHosts(env, mode, oidc ? urlsplit(oidc.redirect_url).netloc : null),
    single_user: singleUser,
    user_header: env.MAHLWERK_PROXY_USER_HEADER ?? 'Remote-User',
    name_header: env.MAHLWERK_PROXY_NAME_HEADER ?? 'Remote-Name',
    groups_header: env.MAHLWERK_PROXY_GROUPS_HEADER ?? 'Remote-Groups',
    admin_group: adminGroup, household_groups: householdGroups, trusted,
    // behind a TLS proxy the app itself only sees HTTP: an https public address of the oidc mode says "secure" too
    cookie_secure: ['1', 'true', 'yes'].includes((env.MAHLWERK_COOKIE_SECURE ?? '').trim().toLowerCase()) || (oidc !== null && oidc.redirect_url.startsWith('https://')),
  };
}

/** What a running app keeps besides the database (app.state of the Python side). Made once by `initAuth`. */
export interface AuthState {
  config: AuthConfig;
  hasher: PasswordHasher;
  throttle: LoginThrottle;
  setupToken: string | null;
  oidc: OidcClient | null;
  oidcRate: { login: RateLimit; callback: RateLimit };
  keys: Map<string, Uint8Array>;
}

/** Called by makeApp. `ctx.services.passwordCost` is the test-only way to lower the scrypt cost (only the test host sets it). */
export function initAuth(ctx: Ctx): AuthState {
  const config = authConfigFromEnv(ctx.env);
  const cost = ctx.services.passwordCost as [number, number, number] | undefined;
  const clock = () => ctx.now();
  const state: AuthState = {
    config, hasher: new PasswordHasher(ctx, cost), throttle: new LoginThrottle(clock), setupToken: null,
    oidc: config.oidc ? new OidcClient(ctx, config.oidc) : null,
    oidcRate: { login: new RateLimit(clock), callback: new RateLimit(clock) }, keys: new Map(),
  };
  ctx.services.auth = state;
  ctx.services.demoDataOn = ['1', 'true'].includes((ctx.env.MAHLWERK_DEMO_DATA ?? '').trim().toLowerCase()); // read once, like app.state.demo_enabled
  return state;
}

export const authState = (ctx: Ctx): AuthState => ctx.services.auth as AuthState;
export const configOf = (ctx: Ctx): AuthConfig => authState(ctx).config;

/** A cookie key kept in the database (oidc sign-in, demo switch), read at first use. */
export async function cookieKey(ctx: Ctx, name: string): Promise<Uint8Array> {
  const state = authState(ctx);
  let key = state.keys.get(name);
  if (!key) { key = await secretKey(ctx.db, name); state.keys.set(name, key); }
  return key;
}

/** Servers hand UTF-8 header bytes over as latin-1 text; undo that. */
export function headerText(value: string): string {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c > 255) return value;
    bytes[i] = c;
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return value; }
}

const peerIp = (req: Req): Ip | null => parseIp(req.peer);

/** Only the TCP peer counts. X-Forwarded-For is client-controlled and never consulted. */
export function peerIsTrusted(req: Req, trusted: Set<string>): boolean {
  const ip = peerIp(req);
  return ip !== null && trusted.has(ipKey(ip));
}

/** A fresh access token: `mw_` and 43 URL-safe characters (32 random bytes). */
export const newToken = (): string => TOKEN_PREFIX + tokenUrlsafe(32);
export const hashToken = (token: string): Promise<string> => sha256Hex(token);

/** The access token in `Authorization: Bearer mw_...`, if there is one. Never read from the URL. */
export function bearerToken(req: Req): string | null {
  const header = req.headers.authorization ?? '';
  const space = header.indexOf(' ');
  const scheme = space < 0 ? header : header.slice(0, space);
  const value = (space < 0 ? '' : header.slice(space + 1)).trim();
  return scheme.toLowerCase() === 'bearer' && value.startsWith(TOKEN_PREFIX) ? value : null;
}

/** Whether people in these groups belong to the household (everybody does while MAHLWERK_HOUSEHOLD_GROUPS is not set). */
export const isHouseholdGroup = (config: AuthConfig, groups: Set<string>): boolean =>
  config.household_groups === null || [...config.household_groups].some((g) => groups.has(g));

/** The household flag of a user whose value comes from the database (access token, session). An admin is always household. In the
 * local mode the stored flag decides; in the other modes, while no household groups are configured, everybody is household. */
export function effectiveHousehold(config: AuthConfig, stored: boolean, admin = false): boolean {
  if (admin || config.mode === 'single') return true;
  if (config.mode !== 'local' && config.household_groups === null) return true;
  return Boolean(stored);
}

async function tokenUser(req: Req, token: string): Promise<User> {
  const { ctx } = req;
  if (!(await featureOn(ctx, 'access_tokens.enabled'))) throw new HttpError(401, 'access tokens are switched off');
  const config = configOf(ctx);
  // in local mode a user without a password (left over from single/proxy) has no valid keys
  const row = await findToken(ctx.db, await hashToken(token), config.mode === 'local');
  if (row === undefined) throw new HttpError(401, 'invalid, expired or revoked access token');
  if (row.scope === 'read' && !READ_METHODS.includes(req.method) && !READ_ONLY_POSTS.includes(req.path)) throw new HttpError(403, 'this access token may only read');
  await touchToken(ctx.db, row.token_id);
  // a token never makes its owner an admin and cannot manage tokens or webhooks (see `sessionUser`)
  return { id: row.id, username: row.username, display_name: row.display_name, is_admin: false, via_token: true, household: effectiveHousehold(config, Boolean(row.household)) };
}

function groupsOf(req: Req, config: AuthConfig): Set<string> {
  const raw = headerText(req.headers[config.groups_header.toLowerCase()] ?? '');
  return new Set(raw.split(',').map((p) => p.trim()).filter(Boolean));
}

const isAdminHeader = (req: Req, config: AuthConfig): boolean => config.mode === 'single' || groupsOf(req, config).has(config.admin_group);

/** The address the brake counts: the TCP peer, or, when the peer is a trusted proxy, the last X-Forwarded-For entry (the one that
 * proxy appended itself; earlier entries are client-controlled). */
export function clientIp(req: Req, config: AuthConfig): string {
  const peer = req.peer || 'unknown';
  if (req.peer && peerIsTrusted(req, config.trusted)) {
    const forwarded = (req.headers['x-forwarded-for'] ?? '').split(',').at(-1)!.trim();
    if (forwarded) return [...forwarded].slice(0, 64).join('');
  }
  return peer;
}

/** Whether the session cookie gets the `Secure` flag: the request came over HTTPS, a trusted proxy says so, or MAHLWERK_COOKIE_SECURE
 * is set (behind a TLS proxy the app itself only sees HTTP). */
export function isSecure(req: Req, config: AuthConfig): boolean {
  if (config.cookie_secure || req.scheme === 'https') return true;
  return peerIsTrusted(req, config.trusted) && (req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim().toLowerCase() === 'https';
}

/** `__Host-mahlwerk_session` when the cookie is Secure, else `mahlwerk_session`. Only the name that fits the request is read: over
 * HTTPS the unprefixed cookie (which a sibling site could have planted) is never looked at. */
export const sessionCookieName = (req: Req): string => (isSecure(req, configOf(req.ctx)) ? HOST_PREFIX + SESSION_COOKIE : SESSION_COOKIE);

export function setSessionCookie(req: Req, token: string): void {
  const config = configOf(req.ctx);
  outOf(req).cookies.push(setCookieHeader(sessionCookieName(req), token, { maxAge: config.session_ttl, secure: isSecure(req, config) }));
}

export function clearSessionCookie(req: Req): void {
  outOf(req).cookies.push(deleteCookieHeader(sessionCookieName(req), isSecure(req, configOf(req.ctx))));
}

/** Sign this browser in as the user: a new session (the one it had before ends) and its cookie. */
export async function startSession(req: Req, userId: number): Promise<void> {
  const { ctx } = req;
  const config = configOf(ctx);
  const old = cookiesOf(req)[sessionCookieName(req)];
  if (old) await deleteSession(ctx.db, await hashToken(old));
  const token = tokenUrlsafe(32);
  await createSession(ctx.db, userId, await hashToken(token), Math.trunc(ctx.now()), config.session_ttl);
  setSessionCookie(req, token);
}

async function sessionUserRow(req: Req): Promise<User> {
  const { ctx } = req;
  const config = configOf(ctx);
  const token = cookiesOf(req)[sessionCookieName(req)] ?? '';
  const row = token ? await findSession(ctx.db, await hashToken(token), Math.trunc(ctx.now()), config.session_ttl, config.session_max_age,
    { requirePassword: config.mode === 'local', oidcIssuer: config.oidc ? config.oidc.issuer : null }) : null;
  if (row === null) throw new HttpError(401, 'not authenticated');
  if (row.renewed) setSessionCookie(req, token); // keep the cookie as long-lived as the sliding session
  return { id: row.id, username: row.username, display_name: row.display_name, is_admin: row.local_admin, via_token: false,
    session_hash: await hashToken(token), household: effectiveHousehold(config, row.household, row.local_admin) };
}

/** The cookie of the demo switch: `__Host-mahlwerk_demo` when Secure, else `mahlwerk_demo` (same reasoning as the session cookie). */
export const demoCookieName = (req: Req): string => (isSecure(req, configOf(req.ctx)) ? HOST_PREFIX + demoAccount.COOKIE : demoAccount.COOKIE);
export const isSessionMode = (req: Req): boolean => SESSION_MODES.includes(configOf(req.ctx).mode);

export function setDemoCookie(req: Req, value: string): void {
  outOf(req).cookies.push(setCookieHeader(demoCookieName(req), value, { maxAge: isSessionMode(req) ? demoAccount.TTL : demoAccount.TTL_UNBOUND, secure: isSecure(req, configOf(req.ctx)) }));
}

export function clearDemoCookie(req: Req): void {
  outOf(req).cookies.push(deleteCookieHeader(demoCookieName(req), isSecure(req, configOf(req.ctx))));
}

/** `real` itself, or, while it has switched to the demo account, the demo user. The cookie is looked at on every request and counts
 * only while ALL of this holds: the caller did not use an access token, the real identity is an admin right now (proxy: from the
 * group header of THIS request), the demo account is switched on and exists, and the cookie is genuine, unexpired and made for this
 * very user and session. Anything else: the cookie is ignored (and removed), the request is simply the real user's. */
async function demoView(req: Req, real: User): Promise<User> {
  if (real.via_token) return real;
  const value = cookiesOf(req)[demoCookieName(req)];
  if (!value) return real;
  const { ctx } = req;
  let demoRow: { id: number; username: string; display_name: string } | undefined;
  let demoId: number | null;
  if (real.is_admin && (await featureOn(ctx, 'demo_account.enabled')) && (demoId = await demoAccountReady(ctx.db)) !== null) {
    if (await demoAccount.openCookie(await cookieKey(ctx, demoAccount.KEY_NAME), value, real.id, real.session_hash, ctx.now())) {
      demoRow = await ctx.db.get('SELECT id, username, display_name FROM user WHERE username = ?', [RESERVED_USERNAME]);
      if (demoRow !== undefined && demoRow.id !== demoId) demoRow = undefined;
    }
  }
  if (demoRow === undefined) { clearDemoCookie(req); return real; }
  return { id: demoRow.id, username: demoRow.username, display_name: demoRow.display_name, is_admin: false, via_token: false, is_demo: true,
    session_hash: real.session_hash, household: true };
}

/** The name shown for a user: the one they chose, else the provider's (proxy header, OIDC claim, local setup), else the user name. */
export async function effectiveName(ctx: Ctx, userId: number, providerName: string, username: string): Promise<string> {
  return (await ownName(ctx, userId)) || providerName || username;
}

/** The caller (see `identity`) with the display name they chose, which wins over the provider's name in every mode.
 * `provider_name` keeps the name the provider delivered; `name_custom` says whether the shown name is the user's own. */
export async function currentUser(req: Req): Promise<User> {
  const real = await identity(req);
  const user = await demoView(req, real);
  const own = await ownName(req.ctx, user.id);
  const actual = user.is_demo ? 'demo' : 'own';
  demoAccount.checkView(req, actual, real.via_token);
  if (!real.via_token) outOf(req).headers[demoAccount.VIEW_HEADER] = actual; // every answer says which account it is for
  const out: User = { ...user, is_demo: Boolean(user.is_demo), display_name: own || user.display_name || user.username, provider_name: user.display_name, name_custom: own !== null };
  if (user.is_demo) {
    demoAccount.enforce(req, user); // a demo request may do only what the table in demoAccount.ts allows
    out.demo_real = { username: real.username, display_name: (await ownName(req.ctx, real.id)) || real.display_name || real.username };
  }
  return out;
}

/** The user row (id, username, display_name), created on first sight (single, proxy), and whether the caller is an admin (single:
 * always; proxy: decided per request from the proxy's group header, never stored; local: the stored admin flag; oidc: the flag set at
 * the last sign-in from the provider's groups) and whether an access token was used (`via_token`; such a caller is never an admin). A
 * token wins over proxy headers and cookies and works in every mode, from any peer. This is the REAL identity; `currentUser` may turn
 * it into the demo account (see `demoView`). */
export async function identity(req: Req): Promise<User> {
  const token = bearerToken(req);
  if (token !== null) return tokenUser(req, token);
  const { ctx } = req;
  const config = configOf(ctx);
  if (SESSION_MODES.includes(config.mode)) return sessionUserRow(req);
  let username: string, display: string;
  if (config.mode === 'single') {
    username = config.single_user;
    display = config.single_user;
  } else {
    if (!peerIsTrusted(req, config.trusted)) throw new HttpError(401, 'not authenticated');
    username = headerText(req.headers[config.user_header.toLowerCase()] ?? '').trim();
    if (!username || [...username].length > 200) throw new HttpError(401, 'not authenticated');
    display = [...headerText(req.headers[config.name_header.toLowerCase()] ?? '').trim()].slice(0, 200).join('') || username;
  }
  if (isReservedName(username)) throw new HttpError(403, 'this user name is reserved'); // nobody is the demo account
  const admin = isAdminHeader(req, config);
  const household = config.mode === 'single' || admin || isHouseholdGroup(config, groupsOf(req, config));
  const { disabled, ...user } = await getOrCreateUser(ctx, username, display, household); // the flag is renewed with every request
  if (disabled && config.mode === 'proxy') throw new HttpError(403, BLOCKED); // blocked in the admin area: the proxy still lets them in, Mahlwerk does not
  return { ...user, is_admin: admin, via_token: false, household };
}

/** The caller as they really are, never the demo account (starting and ending the demo switch): signed in the normal way, so an
 * access token is refused. */
export async function realUser(req: Req): Promise<User> {
  const user = await identity(req);
  if (user.via_token) throw new HttpError(403, 'not available with an access token');
  return user;
}

/** The caller signed in the normal way: an access token is refused (managing tokens or webhooks). */
export async function sessionUser(req: Req): Promise<User> {
  const user = req.user ?? (req.user = await currentUser(req));
  if (user.via_token) throw new HttpError(403, 'not available with an access token');
  return user;
}

export async function requireAdmin(req: Req): Promise<User> {
  const user = await sessionUser(req);
  if (!user.is_admin) throw new HttpError(403, 'admin only');
  return user;
}
