// Users, accounts of the local sign-in mode, sessions and OIDC identities (db.py: get_or_create_user, own_name, local_user,
// setup_first_admin, find_session, oidc_sign_in …).
import type { Db } from '../db.ts';
import type { Ctx } from '../http.ts';
import { HttpError } from '../http.ts';
import { setSetting } from './settings.ts';

export const RESERVED_USERNAME = '~demo';
export const isReservedName = (username: string) => username.trim().toLowerCase() === RESERVED_USERNAME;

export interface UserRow { id: number; username: string; display_name: string; household: boolean; disabled: boolean }

/** The user of this name, created on first sight. `household` undefined leaves a known user's flag alone. */
export async function getOrCreateUser(ctx: Ctx, username: string, displayName: string, household?: boolean): Promise<UserRow> {
  if (isReservedName(username)) throw new HttpError(403, 'reserved user name');
  return ctx.db.tx(async (db) => {
    const row = await db.get('SELECT * FROM user WHERE username = ?', [username]);
    if (!row) {
      const r = await db.run('INSERT INTO user (username, display_name, created_at, household) VALUES (?, ?, ?, ?)',
        [username, displayName, Math.floor(Date.now() / 1000), household === false ? 0 : 1]);
      return { id: r.lastId, username, display_name: displayName, household: household !== false, disabled: false };
    }
    if (row.display_name !== displayName) await db.run('UPDATE user SET display_name = ? WHERE id = ?', [displayName, row.id]);
    if (household !== undefined && Boolean(row.household) !== household) {
      await db.run('UPDATE user SET household = ? WHERE id = ?', [household ? 1 : 0, row.id]);
    }
    return { id: row.id, username, display_name: displayName, household: household ?? Boolean(row.household), disabled: Boolean(row.disabled) };
  });
}

/** The display name the user chose themself (setting `display_name`), or null. */
export async function ownName(ctx: Ctx, userId: number): Promise<string | null> {
  const row = await ctx.db.get('SELECT value FROM user_setting WHERE user_id = ? AND key = ?', [userId, 'display_name']);
  return row ? JSON.parse(row.value) : null;
}

/** The own display name is chosen by the user themself; null goes back to the provider's name (or the user name). */
export async function setOwnName(db: Db, userId: number, name: string | null): Promise<void> {
  if (name === null) await db.run("DELETE FROM user_setting WHERE user_id = ? AND key = 'display_name'", [userId]);
  else await setSetting(db, userId, 'display_name', name);
}

export class NameTaken extends Error {}
/** The user name is reserved for the demo account. */
export class ReservedName extends NameTaken {}
export class SetupDone extends Error {}
/** An OpenID Connect sign-in cannot be mapped to a user; `code` is one of blocked, conflict, exists, name. */
export class SignInRefused extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
/** The change would leave the server without an active admin. */
export class LastAdmin extends Error {}

const now = () => Math.floor(Date.now() / 1000); // time.time()

const activeAdmins = async (db: Db, besides: number | null): Promise<number> =>
  (await db.get('SELECT count(*) AS n FROM user WHERE local_admin = 1 AND disabled = 0 AND password_hash IS NOT NULL AND id IS NOT ?', [besides]))!.n;

/** True while nobody has a password yet: the first-start page may create the first admin. */
export async function needsSetup(db: Db): Promise<boolean> {
  return (await db.get('SELECT 1 FROM user WHERE password_hash IS NOT NULL')) === undefined;
}

export async function hasUsers(db: Db): Promise<boolean> {
  return (await db.get('SELECT 1 FROM user')) !== undefined;
}

/** The account with this name (case-insensitive unless `exact`) including its password hash. */
export async function localUser(db: Db, username: string, exact = false): Promise<Record<string, any> | undefined> {
  return exact ? db.get('SELECT * FROM user WHERE username = ?', [username])
    : db.get('SELECT * FROM user WHERE lower(username) = ?', [pyLower(username)]);
}

/** str.lower() as far as SQLite's lower() (ASCII only) and Python agree: the names here are ASCII (checked at creation). */
const pyLower = (s: string) => s.toLowerCase();

/** Create the first admin, only while no user has a password (one write lock). A user of the same name without a password (an
 * older single-user or proxy database) is taken over with its data. */
export async function setupFirstAdmin(db: Db, username: string, displayName: string, passwordHash: string): Promise<{ id: number; username: string; display_name: string }> {
  if (isReservedName(username)) throw new ReservedName(username);
  return db.tx(async (tx) => {
    if ((await tx.get('SELECT 1 FROM user WHERE password_hash IS NOT NULL')) !== undefined) throw new SetupDone();
    const row = await tx.get('SELECT id FROM user WHERE lower(username) = ?', [pyLower(username)]);
    let userId: number;
    if (row === undefined) {
      userId = (await tx.run('INSERT INTO user (username, display_name, created_at, password_hash, local_admin) VALUES (?, ?, ?, ?, 1)',
        [username, displayName, now(), passwordHash])).lastId;
    } else {
      userId = row.id;
      await tx.run('UPDATE user SET password_hash = ?, local_admin = 1, disabled = 0, display_name = ? WHERE id = ?', [passwordHash, displayName, userId]);
    }
    return { id: userId, username, display_name: displayName };
  });
}

export async function createLocalUser(db: Db, username: string, displayName: string, passwordHash: string, admin: boolean, household = true) {
  if (isReservedName(username)) throw new ReservedName(username);
  return db.tx(async (tx) => {
    if ((await tx.get('SELECT 1 FROM user WHERE lower(username) = ?', [pyLower(username)])) !== undefined) throw new NameTaken();
    const r = await tx.run('INSERT INTO user (username, display_name, created_at, password_hash, local_admin, household) VALUES (?, ?, ?, ?, ?, ?)',
      [username, displayName, now(), passwordHash, admin ? 1 : 0, household || admin ? 1 : 0]);
    return { id: r.lastId, username, display_name: displayName };
  });
}

export async function setPassword(db: Db, userId: number, passwordHash: string): Promise<void> {
  await db.run('UPDATE user SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
}

/** Block or unblock, give or take the admin right. The last active admin can be neither blocked nor demoted (unless `guardAdmins`
 * is false: in proxy and single mode the stored admin flag is a leftover and decides nothing). Blocking also ends the sessions. */
export async function changeAccount(db: Db, userId: number, o: { disabled?: boolean | null; admin?: boolean | null; household?: boolean | null; guardAdmins?: boolean }): Promise<void> {
  await db.tx(async (tx) => {
    const row = (await tx.get('SELECT disabled, local_admin, password_hash FROM user WHERE id = ?', [userId]))!;
    const nowActive = Boolean(row.local_admin) && !row.disabled && row.password_hash !== null;
    const newDisabled = o.disabled == null ? Boolean(row.disabled) : o.disabled;
    const newAdmin = o.admin == null ? Boolean(row.local_admin) : o.admin;
    if ((o.guardAdmins ?? true) && nowActive && (newDisabled || !newAdmin) && (await activeAdmins(tx, userId)) === 0) throw new LastAdmin();
    await tx.run('UPDATE user SET disabled = ?, local_admin = ? WHERE id = ?', [newDisabled ? 1 : 0, newAdmin ? 1 : 0, userId]);
    if (o.household != null || newAdmin) { // an admin is always a member: the stored flag says so too (an access key reads it)
      await tx.run('UPDATE user SET household = ? WHERE id = ?', [newAdmin || Boolean(o.household) ? 1 : 0, userId]);
    }
    if (newDisabled) await tx.run('DELETE FROM auth_session WHERE user_id = ?', [userId]);
  });
}

/** Revoke every access token of the user that is not revoked yet; the number revoked. */
export async function revokeUserTokens(db: Db, userId: number): Promise<number> {
  return (await db.run('UPDATE access_token SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now(), userId])).changes;
}

export async function createSession(db: Db, userId: number, tokenHash: string, at: number, ttl: number): Promise<void> {
  await db.tx(async (tx) => {
    await tx.run('DELETE FROM auth_session WHERE expires_at <= ?', [at]); // clean up while signing in
    await tx.run('INSERT INTO auth_session (user_id, hash, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)', [userId, tokenHash, at, at + ttl, at]);
  });
}

/** The user of a live session of an unblocked account, or null. The session slides: `last_seen` and the expiry are written at most
 * once per `every` seconds (`renewed` says that this happened), but never beyond `maxAge` seconds after the session was created.
 * Accounts of the local mode need a password (`requirePassword`); those of the oidc mode have none: there (`oidcIssuer`) a session
 * counts only for a user who has an identity at that issuer. */
export async function findSession(db: Db, tokenHash: string, at: number, ttl: number, maxAge: number, o: { every?: number; requirePassword?: boolean; oidcIssuer?: string | null } = {}) {
  const every = o.every ?? 60;
  const issuer = o.oidcIssuer ?? null;
  return db.tx(async (tx) => {
    const row = await tx.get(
      'SELECT s.id AS session_id, s.last_seen, s.created_at, u.id, u.username, u.display_name, u.local_admin, u.household FROM auth_session s ' +
      'JOIN user u ON u.id = s.user_id WHERE s.hash = ? AND s.expires_at > ? AND s.created_at > ? AND u.disabled = 0 ' +
      "AND u.username <> '~demo' " + // the demo account never signs in (RESERVED_USERNAME)
      'AND (? = 0 OR u.password_hash IS NOT NULL) ' +
      'AND (? IS NULL OR EXISTS (SELECT 1 FROM oidc_identity i WHERE i.user_id = u.id AND i.issuer = ?))',
      [tokenHash, at, at - maxAge, o.requirePassword === false ? 0 : 1, issuer, issuer]);
    if (row === undefined) return null;
    const renewed = row.last_seen <= at - every;
    if (renewed) await tx.run('UPDATE auth_session SET last_seen = ?, expires_at = ? WHERE id = ?', [at, Math.min(at + ttl, row.created_at + maxAge), row.session_id]);
    return { id: row.id as number, username: row.username as string, display_name: row.display_name as string,
      local_admin: Boolean(row.local_admin), household: Boolean(row.household), renewed };
  });
}

export async function sessionUserId(db: Db, tokenHash: string): Promise<number | null> {
  const row = await db.get('SELECT user_id FROM auth_session WHERE hash = ?', [tokenHash]);
  return row ? row.user_id : null;
}

export async function deleteSession(db: Db, tokenHash: string): Promise<void> {
  await db.run('DELETE FROM auth_session WHERE hash = ?', [tokenHash]);
}

export async function deleteUserSessions(db: Db, userId: number, keepHash: string | null = null): Promise<number> {
  return (await db.run('DELETE FROM auth_session WHERE user_id = ? AND hash IS NOT ?', [userId, keepHash])).changes;
}

/** The user for a verified provider identity, created or linked on the first sign-in. Throws SignInRefused.
 * Known (issuer, sub): the same user whatever the name is now; the display name and the admin right follow the provider's claims,
 * the user name stays. New identity: a user of that name that already exists is taken over only when it has no identity at this
 * issuer yet AND `linkExisting` is on (code `exists` otherwise; `conflict` when the name belongs to another identity). Blocked
 * users are refused and left untouched. One write lock. */
export async function oidcSignIn(db: Db, issuer: string, sub: string, username: string, displayName: string, admin: boolean, linkExisting: boolean, household = true) {
  if (isReservedName(username)) throw new SignInRefused('name');
  const at = now();
  return db.tx(async (tx) => {
    let row: Record<string, any> | undefined = await tx.get(
      'SELECT u.id, u.username, u.display_name, u.disabled FROM oidc_identity i JOIN user u ON u.id = i.user_id WHERE i.issuer = ? AND i.sub = ?', [issuer, sub]);
    if (row === undefined) {
      const sameName = await tx.get('SELECT id, username, display_name, disabled FROM user WHERE lower(username) = ?', [pyLower(username)]);
      if (sameName === undefined) {
        const r = await tx.run('INSERT INTO user (username, display_name, created_at) VALUES (?, ?, ?)', [username, displayName, at]);
        row = { id: r.lastId, username, display_name: displayName, disabled: 0 };
      } else {
        if ((await tx.get('SELECT 1 FROM oidc_identity WHERE issuer = ? AND user_id = ?', [issuer, sameName.id])) !== undefined) throw new SignInRefused('conflict');
        if (!linkExisting) throw new SignInRefused('exists');
        row = sameName;
      }
      if (row.disabled) throw new SignInRefused('blocked');
      await tx.run('INSERT INTO oidc_identity (issuer, sub, user_id, created_at, last_login) VALUES (?, ?, ?, ?, ?)', [issuer, sub, row.id, at, at]);
      // sessions the user had before (another mode, another provider) must not come alive through the new link
      await tx.run('DELETE FROM auth_session WHERE user_id = ?', [row.id]);
    } else if (row.disabled) throw new SignInRefused('blocked');
    else await tx.run('UPDATE oidc_identity SET last_login = ? WHERE issuer = ? AND sub = ?', [at, issuer, sub]);
    await tx.run('UPDATE user SET display_name = ?, local_admin = ?, household = ? WHERE id = ?', [displayName, admin ? 1 : 0, household || admin ? 1 : 0, row.id]);
    return { id: row.id as number, username: row.username as string, display_name: displayName, is_admin: admin };
  });
}

export async function findUser(db: Db, username: string): Promise<{ id: number; username: string; display_name: string } | undefined> {
  return db.get('SELECT id, username, display_name FROM user WHERE username = ?', [username]);
}
