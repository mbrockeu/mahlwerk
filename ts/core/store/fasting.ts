// Intervall fasting (db.py: current_fast, get_fast, recent_fasts, start_fast, update_fast, delete_fast).
import type { Db } from '../db.ts';

export interface FastRow { id: number; user_id: number; started_at: number; ended_at: number | null; target_hours: number }

export const currentFast = (db: Db, userId: number): Promise<FastRow | undefined> =>
  db.get('SELECT * FROM fast WHERE user_id = ? AND ended_at IS NULL', [userId]) as Promise<FastRow | undefined>;

export const getFast = (db: Db, userId: number, fastId: number): Promise<FastRow | undefined> =>
  db.get('SELECT * FROM fast WHERE id = ? AND user_id = ?', [fastId, userId]) as Promise<FastRow | undefined>;

/** The latest finished fasts, newest first. */
export const recentFasts = (db: Db, userId: number, limit: number): Promise<FastRow[]> =>
  db.all('SELECT * FROM fast WHERE user_id = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC, id DESC LIMIT ?', [userId, limit]) as Promise<FastRow[]>;

const isConstraint = (e: unknown): boolean => /constraint/i.test(String((e as Error)?.message ?? e));

/** Open a fast. null when one is already open for this user (the unique index refuses a second). */
export async function startFast(db: Db, userId: number, startedAt: number, targetHours: number): Promise<number | null> {
  try {
    return (await db.run('INSERT INTO fast (user_id, started_at, target_hours) VALUES (?, ?, ?)', [userId, startedAt, targetHours])).lastId;
  } catch (e) {
    if (isConstraint(e)) return null;
    throw e;
  }
}

/** Set the given columns (started_at, ended_at, target_hours) of one fast; false when nothing changed or the index refuses. */
export async function updateFast(db: Db, userId: number, fastId: number, changes: Record<string, number>): Promise<boolean> {
  const keys = Object.keys(changes);
  if (!keys.length) return false;
  try {
    return (await db.run(`UPDATE fast SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND user_id = ?`, [...Object.values(changes), fastId, userId])).changes > 0;
  } catch (e) {
    if (isConstraint(e)) return false;
    throw e;
  }
}

export async function deleteFast(db: Db, userId: number, fastId: number): Promise<boolean> {
  return (await db.run('DELETE FROM fast WHERE id = ? AND user_id = ?', [fastId, userId])).changes > 0;
}

