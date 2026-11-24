// Body weights (db.py: weights_between, put_weight, delete_weight, latest_weight).
import type { Db } from '../db.ts';

export interface WeightRow { day: string; kg: number; body_fat_pct?: number; lean_kg?: number }

/** The weights of the range, oldest first; the body values appear only where the day has them (like in the API answer). */
export async function weightsBetween(db: Db, userId: number, first: string, last: string): Promise<WeightRow[]> {
  const rows = await db.all('SELECT day, kg, body_fat_pct, lean_kg FROM weight WHERE user_id = ? AND day BETWEEN ? AND ? ORDER BY day', [userId, first, last]);
  return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) as unknown as WeightRow);
}

/** Set the weight of a day by hand (it is then no health or demo value any more). A key of `body` that is present sets that body
 * value as a hand-typed one (null clears it); an absent key leaves what is stored. Returns the stored row (null values included). */
export async function putWeight(db: Db, userId: number, day: string, kg: number, body: { body_fat_pct?: number | null; lean_kg?: number | null } = {}) {
  const cols: string[] = [], marks: string[] = [], args: (number | null)[] = [], sets: string[] = [];
  for (const [column, flag] of [['body_fat_pct', 'body_fat_health'], ['lean_kg', 'lean_health']] as const) {
    if (!Object.hasOwn(body, column)) continue;
    cols.push(column, flag);
    marks.push('?', '0');
    args.push(body[column] ?? null);
    sets.push(`${column} = excluded.${column}`, `${flag} = 0`);
  }
  await db.run(
    `INSERT INTO weight (user_id, day, kg${cols.map((c) => ', ' + c).join('')}) VALUES (?, ?, ?${marks.map((m) => ', ' + m).join('')}) `
    + `ON CONFLICT(user_id, day) DO UPDATE SET kg = excluded.kg, demo = 0, health = 0, import_id = NULL${sets.map((x) => ', ' + x).join('')}`,
    [userId, day, kg, ...args]);
  return (await db.get('SELECT day, kg, body_fat_pct, lean_kg FROM weight WHERE user_id = ? AND day = ?', [userId, day]))!;
}

export async function deleteWeight(db: Db, userId: number, day: string): Promise<boolean> {
  return (await db.run('DELETE FROM weight WHERE user_id = ? AND day = ?', [userId, day])).changes > 0;
}

export async function latestWeight(db: Db, userId: number) {
  return db.get('SELECT day, kg, body_fat_pct, lean_kg FROM weight WHERE user_id = ? ORDER BY day DESC LIMIT 1', [userId]);
}
