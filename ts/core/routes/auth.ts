// Accounts of this server (MAHLWERK_AUTH=local): first-start setup, sign-in and out, own password, and the admin's user management
// (routes/auth.py). In the modes `single` and `proxy` the sign-in endpoints answer 404, except `status`; blocking a user and revoking
// their access keys and sessions work in every mode (the proxy or provider cannot take back an access key).
import { z } from 'zod';
import {
  SESSION_MODES, authState, clearDemoCookie, clearSessionCookie, clientIp, configOf, currentUser, effectiveName, hashToken, requireAdmin, sessionCookieName,
  sessionUser, startSession,
} from '../auth.ts';
import { compareDigest, tokenUrlsafe } from '../crypto.ts';
import { HttpError, parse, route, type Ctx, type Req, type Route } from '../http.ts';
import { pyBool, pyStr } from '../models/common.ts';
import { cookiesOf, ipv4Mapped, network64, parseIp } from '../netutil.ts';
import { MAX_LENGTH, MIN_LENGTH } from '../passwords.ts';
import {
  LastAdmin, NameTaken, ReservedName, SetupDone, changeAccount, createLocalUser, deleteSession, deleteUserSessions, hasUsers, isReservedName, localUser,
  needsSetup, revokeUserTokens, sessionUserId, setPassword, setupFirstAdmin,
} from '../store/users.ts';
import { PRESSURE_DELAY, QUEUE_WAIT } from '../throttle.ts';

const USERNAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/; // raw value; cleanName lower-cases after the check
const GENERIC = 'invalid user name or password';

export function needLocal(req: Req): void {
  if (configOf(req.ctx).mode !== 'local') throw new HttpError(404, 'not available in this sign-in mode');
}

/** For what works with a session cookie in both modes that have one: sign out. */
export function needSessions(req: Req): void {
  if (!SESSION_MODES.includes(configOf(req.ctx).mode)) throw new HttpError(404, 'not available in this sign-in mode');
}

/** Who ends their sessions: Cookidoo and Yazio keep memory of a person (a sign-in, a running fetch, a staging area); the packages that
 * own them register `ctx.services.userEnded` to drop it. Without it there is nothing to drop. */
export async function userEnded(ctx: Ctx, userId: number): Promise<void> {
  await (ctx.services.userEnded as ((id: number) => Promise<void> | void) | undefined)?.(userId);
}

function cleanName(value: string): string {
  const v = value.trim();
  // ASCII and the pattern on the raw value, lower-casing last: "K" (Kelvin sign) would otherwise turn into a plain "k"
  if (!/^[\x00-\x7f]*$/.test(v) || !USERNAME.test(v)) throw new Error('user name: 1 to 40 letters a-z, digits, dot, dash or underscore, starting with a letter or digit');
  if (isReservedName(v)) throw new Error('this user name is reserved');
  return v.toLowerCase();
}

const username = () => pyStr(1, 40).transform((value, ctx) => {
  try { return cleanName(value); } catch (e) {
    ctx.issues.push({ code: 'custom', message: (e as Error).message, input: value });
    return z.NEVER;
  }
});
const displayName = () => z.string().transform((s) => s.trim()).pipe(pyStr(0, 80)).default('');
const password = () => pyStr(MIN_LENGTH, MAX_LENGTH);

const setupIn = z.object({ username: username(), display_name: displayName(), password: password(), setup_code: pyStr(0, 200).default('') });
const newUser = z.object({ username: username(), display_name: displayName(), password: password(), is_admin: pyBool().default(false), household: pyBool().default(true) });
const login = z.object({ username: pyStr(1, 200), password: pyStr(1, MAX_LENGTH) });
const passwordChange = z.object({ current_password: pyStr(1, MAX_LENGTH), new_password: password() });
const passwordReset = z.object({ password: password() });
const userPatch = z.object({ disabled: pyBool().nullable().default(null), is_admin: pyBool().nullable().default(null), household: pyBool().nullable().default(null) });

/** The Account of the API: `disabled` and `household` read as their defaults where the dict has no value. */
const account = (a: { username: string; display_name: string; is_admin: boolean; disabled?: boolean; household?: boolean }) =>
  ({ username: a.username, display_name: a.display_name, is_admin: a.is_admin, disabled: a.disabled ?? false, household: a.household ?? true });

/** The client address for the brake; an IPv6 address counts as its /64 network (one customer holds a whole /64). */
export function addressKey(req: Req): string {
  const host = clientIp(req, configOf(req.ctx));
  const addr = parseIp(host.split('%')[0]!);
  if (addr === null) return 'ip:' + host;
  if (addr.v === 6) {
    const mapped = ipv4Mapped(addr);
    return 'ip:' + (mapped !== null ? mapped : network64(addr));
  }
  return 'ip:' + host;
}

/** Refuse with 429 while this address or this name from this address is held back. Returns (address key, pair key, normalised name);
 * the name is normalised exactly like the account lookup, so "Alex " and "alex" are one. */
function brake(req: Req, rawName: string): [string, string, string] {
  const name = [...rawName.trim().toLowerCase()].slice(0, 200).join('');
  const address = addressKey(req);
  const pair = `p:${name}|${address}`;
  const wait = authState(req.ctx).throttle.wait(address, pair);
  if (wait) throw new HttpError(429, 'too many failed attempts, try again later', { 'Retry-After': String(wait) });
  return [address, pair, name];
}

/** The code that guards the setup of a non-empty database. Made once; written to the log only when it was not given. */
export function setupCode(ctx: Ctx): string {
  const state = authState(ctx);
  if (state.setupToken === null) {
    state.setupToken = tokenUrlsafe(16);
    console.warn(`Mahlwerk setup code (needed once to create the first admin): ${state.setupToken}`);
  }
  return state.setupToken;
}

/** What the local mode does when the app is made: the dummy hash (so that the first unknown user name does not cost an extra scrypt run)
 * and, for a database that already holds users (a switch from single or proxy mode), the setup code: MAHLWERK_SETUP_TOKEN, else a
 * random one written to the log. An empty database needs no code. */
export async function startLocal(ctx: Ctx): Promise<void> {
  const state = authState(ctx);
  if (state.config.mode !== 'local') return;
  await state.hasher.dummy();
  if ((await needsSetup(ctx.db)) && (await hasUsers(ctx.db))) {
    const given = (ctx.env.MAHLWERK_SETUP_TOKEN ?? '').trim();
    if (given) state.setupToken = given;
    else setupCode(ctx);
  }
}

async function target(ctx: Ctx, name: string) {
  // the exact name first: in proxy mode names come from a header and two may differ in case only
  const row = (await localUser(ctx.db, name, true)) ?? (await localUser(ctx.db, name.trim()));
  if (row === undefined) throw new HttpError(404, 'unknown user');
  if (isReservedName(row.username)) throw new HttpError(409, 'the demo account is managed in the admin area, not here'); // never as a user
  return row;
}

// where the admin right and the household come from in the modes where the admin area cannot set them
const OUTSIDE: Record<string, string> = { oidc: "the provider's groups", proxy: "the proxy's groups", single: 'the configuration' };

export const routes: Route[] = [
  // Public. Says how people sign in here and whether this caller already is.
  route('GET', '/api/v1/auth/status', async (req) => {
    const { ctx } = req;
    const config = configOf(ctx);
    let user = null;
    try { user = await currentUser(req); } catch (e) { if (!(e instanceof HttpError)) throw e; }
    const setup = config.mode === 'local' && (await needsSetup(ctx.db));
    return {
      mode: config.mode, ...(config.mode === 'oidc' ? { oidc_label: config.oidc!.button_label || null } : {}),
      setup_required: setup, setup_code_required: setup && (await hasUsers(ctx.db)), authenticated: user !== null,
      username: user && user.username, display_name: user && user.display_name, is_admin: user && user.is_admin,
    };
  }, { auth: false }),

  // Create the first admin and sign in. Possible only while nobody has a password; afterwards 409. When the database already holds
  // users (a switch from single or proxy mode) the setup code is required.
  route('POST', '/api/v1/auth/setup', async (req) => {
    needLocal(req);
    const { ctx } = req;
    const body = parse(setupIn, req.body);
    if (!(await needsSetup(ctx.db))) throw new HttpError(409, 'already set up');
    const state = authState(ctx);
    if (await hasUsers(ctx.db)) {
      const keys = brake(req, 'setup code');
      if (!compareDigest(body.setup_code, setupCode(ctx))) {
        state.throttle.fail([keys[0], keys[1]]);
        throw new HttpError(403, 'the setup code is wrong');
      }
    }
    let user;
    try {
      user = await setupFirstAdmin(ctx.db, body.username, body.display_name || body.username, await state.hasher.hash(body.password));
    } catch (e) {
      if (e instanceof SetupDone) throw new HttpError(409, 'already set up');
      if (e instanceof ReservedName) throw new HttpError(422, 'this user name is reserved');
      throw e;
    }
    await startSession(req, user.id);
    return account({ username: user.username, display_name: user.display_name, is_admin: true });
  }, { auth: false, status: 201 }),

  route('POST', '/api/v1/auth/login', async (req) => {
    needLocal(req);
    const { ctx } = req;
    const body = parse(login, req.body);
    const [address, pair, name] = brake(req, body.username);
    const { throttle, hasher } = authState(ctx);
    const pressure = throttle.underPressure(name);
    const turn = pressure ? throttle.nameTurn(name) : null;
    if (turn !== null && !(await turn.acquire(QUEUE_WAIT))) throw new HttpError(429, 'too many attempts for this user name, try again in a moment', { 'Retry-After': '5' });
    let row;
    try {
      row = await localUser(ctx.db, name);
      if (row !== undefined && isReservedName(row.username)) row = undefined; // the demo account has no password and nobody signs in as it
      // an unknown name still costs one scrypt run, so timing does not tell it apart from a wrong password
      const ok = await hasher.verify(body.password, row ? row.password_hash : null);
      if (row === undefined || !ok || row.disabled) { // a blocked account answers like a wrong password
        throttle.fail([address, pair], name);
        if (pressure) await throttle.sleep(PRESSURE_DELAY);
        throw new HttpError(401, GENERIC);
      }
    } finally {
      if (turn !== null) turn.release();
    }
    throttle.success(pair); // the address keeps its count: one's own login must not wipe a guessing run
    if (hasher.needsRehash(row.password_hash)) await setPassword(ctx.db, row.id, await hasher.hash(body.password));
    await startSession(req, row.id);
    return account({ username: row.username, display_name: await effectiveName(ctx, row.id, row.display_name, row.username), is_admin: Boolean(row.local_admin) });
  }, { auth: false }),

  route('POST', '/api/v1/auth/logout', async (req) => {
    needSessions(req);
    const { ctx } = req;
    const token = cookiesOf(req)[sessionCookieName(req)];
    if (token) {
      const userId = await sessionUserId(ctx.db, await hashToken(token));
      await deleteSession(ctx.db, await hashToken(token));
      if (userId !== null) await userEnded(ctx, userId); // the person's own Cookidoo sign-in and a running Yazio fetch end with the session
    }
    clearSessionCookie(req);
    clearDemoCookie(req); // signing out ends a switch to the demo account too
    return undefined;
  }, { auth: false, status: 204 }),

  // Change the own password (the old one is required). All other sessions of this user end; access keys stay valid.
  route('POST', '/api/v1/auth/password', async (req) => {
    needLocal(req);
    const user = await sessionUser(req);
    const body = parse(passwordChange, req.body);
    const { ctx } = req;
    const [address, pair, name] = brake(req, user.username);
    const { hasher, throttle } = authState(ctx);
    const row = await localUser(ctx.db, name);
    if (row === undefined || !(await hasher.verify(body.current_password, row.password_hash))) {
      throttle.fail([address, pair]);
      throw new HttpError(403, 'the current password is wrong');
    }
    throttle.success(pair);
    await setPassword(ctx.db, user.id, await hasher.hash(body.new_password));
    await deleteUserSessions(ctx.db, user.id, user.session_hash ?? null);
    return undefined;
  }, { auth: false, status: 204 }),

  route('POST', '/api/v1/admin/users', async (req) => {
    await requireAdmin(req);
    needLocal(req);
    const body = parse(newUser, req.body);
    try {
      const user = await createLocalUser(req.ctx.db, body.username, body.display_name || body.username, await authState(req.ctx).hasher.hash(body.password), body.is_admin, body.household);
      return account({ username: user.username, display_name: user.display_name, is_admin: body.is_admin, household: body.household || body.is_admin });
    } catch (e) {
      if (e instanceof ReservedName) throw new HttpError(422, 'this user name is reserved');
      if (e instanceof NameTaken) throw new HttpError(409, 'this user name is taken');
      throw e;
    }
  }, { auth: false, status: 201 }),

  // Block or unblock, give or take the admin right. The last active admin can be neither blocked nor demoted, and nobody blocks
  // themself. In the modes oidc, proxy and single only blocking works: the admin right and the household come from outside.
  route('PATCH', '/api/v1/admin/users/{username}', async (req) => {
    await requireAdmin(req);
    const user = await sessionUser(req);
    const { ctx } = req;
    const config = configOf(ctx);
    const body = parse(userPatch, req.body);
    const row = await target(ctx, req.params.username!);
    const source = OUTSIDE[config.mode];
    if (source !== undefined) {
      if (body.is_admin !== null) throw new HttpError(409, `the admin right comes from ${source}`);
      if (body.household !== null) throw new HttpError(409, `household membership comes from ${source}`);
    }
    if (body.disabled && row.id === user.id) throw new HttpError(409, 'you cannot block yourself');
    try {
      await changeAccount(ctx.db, row.id, { disabled: body.disabled, admin: body.is_admin, household: body.household, guardAdmins: SESSION_MODES.includes(config.mode) });
    } catch (e) {
      if (e instanceof LastAdmin) throw new HttpError(409, 'this is the last active admin');
      throw e;
    }
    if (body.disabled) await userEnded(ctx, row.id);
    const fresh = (await localUser(ctx.db, row.username, true))!;
    return account({ username: fresh.username, display_name: await effectiveName(ctx, fresh.id, fresh.display_name, fresh.username), is_admin: Boolean(fresh.local_admin),
      disabled: Boolean(fresh.disabled), household: Boolean(fresh.household) || Boolean(fresh.local_admin) });
  }, { auth: false }),

  // Revoke all access keys of someone else and end their sessions, in every mode (for a key that leaked, or for someone who was
  // taken out of the proxy's or provider's user list). Revoked keys stay revoked; the account itself stays usable.
  route('POST', '/api/v1/admin/users/{username}/revoke-access', async (req) => {
    await requireAdmin(req);
    const user = await sessionUser(req);
    const { ctx } = req;
    const row = await target(ctx, req.params.username!);
    if (row.id === user.id) throw new HttpError(409, 'use your own access key list and sign-out for yourself');
    const tokens = await revokeUserTokens(ctx.db, row.id);
    const sessions = await deleteUserSessions(ctx.db, row.id);
    await userEnded(ctx, row.id); // like a sign-out: nothing of theirs stays in memory
    return { tokens, sessions };
  }, { auth: false }),

  // Set a new initial password for someone else; their sessions end and their access keys are revoked.
  route('POST', '/api/v1/admin/users/{username}/password', async (req) => {
    await requireAdmin(req);
    needLocal(req);
    const user = await sessionUser(req);
    const { ctx } = req;
    const body = parse(passwordReset, req.body);
    const row = await target(ctx, req.params.username!);
    if (row.id === user.id) throw new HttpError(409, 'use the password change for your own password');
    await setPassword(ctx.db, row.id, await authState(ctx).hasher.hash(body.password));
    await deleteUserSessions(ctx.db, row.id);
    await revokeUserTokens(ctx.db, row.id); // the reset is for a lost or leaked password: the keys go with it
    return undefined;
  }, { auth: false, status: 204 }),
];
