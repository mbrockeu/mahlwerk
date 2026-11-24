// The water counter (db.py: get_water, water_between).
import type { Db } from '../db.ts';

export async function getWater(db: Db, userId: number, day: string): Promise<number> {
  return (await db.get('SELECT ml FROM water WHERE user_id = ? AND day = ?', [userId, day]))?.ml ?? 0;
}

export async function waterBetween(db: Db, userId: number, first: string, last: string): Promise<Record<string, number>> {
  const rows = await db.all('SELECT day, ml FROM water WHERE user_id = ? AND day BETWEEN ? AND ?', [userId, first, last]);
  return Object.fromEntries(rows.map((r) => [r.day, r.ml]));
}
