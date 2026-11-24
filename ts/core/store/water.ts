// The water counter (db.py: get_water, water_between).
import type { Db } from '../db.ts';

export async function getWater(db: Db, userId: number, day: string): Promise<number> {
  return (await db.get('SELECT ml FROM water WHERE user_id = ? AND day = ?', [userId, day]))?.ml ?? 0;
}

export async function waterBetween(db: Db, userId: number, first: string, last: string): Promise<Record<string, number>> {
  const rows = await db.all('SELECT day, ml FROM water WHERE user_id = ? AND day BETWEEN ? AND ?', [userId, first, last]);
  return Object.fromEntries(rows.map((r) => [r.day, r.ml]));
}

export const MAX_WATER_ML = 10000;

/** Add (or subtract) ml; the total stays between 0 and MAX_WATER_ML. Returns the new total. */
export async function addWater(db: Db, userId: number, day: string, delta: number): Promise<number> {
  await db.run('INSERT INTO water (user_id, day, ml) VALUES (?, ?, MAX(0, MIN(?, ?))) '
    + 'ON CONFLICT(user_id, day) DO UPDATE SET ml = MAX(0, MIN(?, ml + ?)), demo = 0, health = 0, import_id = NULL',
  [userId, day, MAX_WATER_ML, delta, MAX_WATER_ML, delta]);
  return (await db.get('SELECT ml FROM water WHERE user_id = ? AND day = ?', [userId, day]))!.ml;
}

export async function putWater(db: Db, userId: number, day: string, ml: number): Promise<number> {
  await db.run('INSERT INTO water (user_id, day, ml) VALUES (?, ?, ?) '
    + 'ON CONFLICT(user_id, day) DO UPDATE SET ml = excluded.ml, demo = 0, health = 0, import_id = NULL', [userId, day, ml]);
  return ml;
}
