// Access tokens (db.py: create_token, list_tokens, revoke_token, find_token, touch_token, count_active_tokens).
import type { Db, Row } from '../db.ts';

const now = () => Math.floor(Date.now() / 1000); // time.time()

export interface TokenRow {
  id: number; name: string; prefix: string; scope: 'read' | 'write'; created_at: number; expires_at: number | null;
  last_used_at: number | null; revoked_at: number | null;
}

const tokenOf = (row: Row): TokenRow => ({
  id: row.id, name: row.name, prefix: row.prefix, scope: row.scope, created_at: row.created_at, expires_at: row.expires_at,
  last_used_at: row.last_used_at, revoked_at: row.revoked_at,
});

export async function createToken(db: Db, userId: number, name: string, prefix: string, tokenHash: string, scope: string, expiresAt: number | null): Promise<TokenRow> {
  const r = await db.run('INSERT INTO access_token (user_id, name, prefix, hash, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, name, prefix, tokenHash, scope, now(), expiresAt]);
  return tokenOf((await db.get('SELECT * FROM access_token WHERE id = ?', [r.lastId]))!);
}

export async function listTokens(db: Db, userId: number): Promise<TokenRow[]> {
  return (await db.all('SELECT * FROM access_token WHERE user_id = ? ORDER BY id DESC', [userId])).map(tokenOf);
}

/** Revoke a token of this user. Revoking twice is fine; an unknown id is not. */
export async function revokeToken(db: Db, userId: number, tokenId: number): Promise<boolean> {
  await db.run('UPDATE access_token SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [now(), tokenId, userId]);
  return (await db.get('SELECT 1 FROM access_token WHERE id = ? AND user_id = ?', [tokenId, userId])) !== undefined;
}

/** The usable token with this hash and its user, or undefined (unknown, revoked, expired, user blocked; in local mode also a user
 * without a password). */
export async function findToken(db: Db, tokenHash: string, requirePassword = false) {
  return db.get(
    'SELECT t.id AS token_id, t.scope, u.id, u.username, u.display_name, u.household FROM access_token t ' +
    'JOIN user u ON u.id = t.user_id WHERE t.hash = ? AND t.revoked_at IS NULL AND u.disabled = 0 ' +
    "AND u.username <> '~demo' " + // the demo account has no keys (RESERVED_USERNAME)
    'AND (t.expires_at IS NULL OR t.expires_at > ?) AND (? = 0 OR u.password_hash IS NOT NULL)',
    [tokenHash, now(), requirePassword ? 1 : 0]);
}

/** Remember that the token was used, at most once per `every` seconds. */
export async function touchToken(db: Db, tokenId: number, every = 60): Promise<void> {
  const at = now();
  await db.run('UPDATE access_token SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)', [at, tokenId, at - every]);
}

export async function countActiveTokens(db: Db): Promise<number> {
  return (await db.get('SELECT count(*) AS n FROM access_token WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)', [now()]))!.n;
}
