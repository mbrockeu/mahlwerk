// Global settings, generated keys and stored secrets (db.py: get_global, set_global, secret_key, vault_salt, put_secret …).
import { fromHex, tokenHex } from '../crypto.ts';
import type { Db } from '../db.ts';
import { toJson } from '../db.ts';

export async function getGlobal(db: Db, key: string, dflt: unknown = null): Promise<any> {
  const row = await db.get('SELECT value FROM setting WHERE key = ?', [key]);
  return row ? JSON.parse(row.value) : dflt;
}

export async function setGlobal(db: Db, key: string, value: unknown): Promise<void> {
  await db.run('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, toJson(value)]);
}

async function hexSetting(db: Db, key: string, bytes: number): Promise<Uint8Array> {
  await db.run('INSERT OR IGNORE INTO setting (key, value) VALUES (?, ?)', [key, toJson(tokenHex(bytes))]);
  const row = await db.get('SELECT value FROM setting WHERE key = ?', [key]);
  return fromHex(JSON.parse(row!.value))!;
}

/** A 32-byte random key kept in the database, made at the first call (two callers at once get the same one). Signs the cookies of
 * the oidc sign-in and the demo switch. Never shown anywhere. */
export const secretKey = (db: Db, name: string): Promise<Uint8Array> => hexSetting(db, 'secret.' + name, 32);

/** The random salt (16 bytes) that stretches MAHLWERK_SECRET_KEY, made at first use and kept in the database. */
export const vaultSalt = (db: Db): Promise<Uint8Array> => hexSetting(db, 'secret.vault_salt', 16);

export async function putSecret(db: Db, userId: number, name: string, blob: Uint8Array): Promise<void> {
  await db.run('INSERT INTO secret (user_id, name, blob, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, name) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at',
    [userId, name, blob, Math.floor(Date.now() / 1000)]);
}

export async function getSecret(db: Db, userId: number, name: string): Promise<Uint8Array | null> {
  const row = await db.get('SELECT blob FROM secret WHERE user_id = ? AND name = ?', [userId, name]);
  return row ? new Uint8Array(row.blob) : null;
}

export async function hasSecret(db: Db, userId: number, name: string): Promise<boolean> {
  return (await db.get('SELECT 1 FROM secret WHERE user_id = ? AND name = ?', [userId, name])) !== undefined;
}

export async function deleteSecret(db: Db, userId: number, name: string): Promise<void> {
  await db.run('DELETE FROM secret WHERE user_id = ? AND name = ?', [userId, name]);
}
