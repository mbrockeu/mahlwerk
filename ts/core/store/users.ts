// Users (db.py: get_or_create_user, own_name …).
import type { Ctx } from '../http.ts';
import { HttpError } from '../http.ts';

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
