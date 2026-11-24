// Activity rows, workouts and the body weight an estimate needs (db.py: activity_between, workouts_between,
// training_days_between, weight_for).
import { TRAINING_MIN_MINUTES } from '../activity.ts';
import type { Db, Row } from '../db.ts';

/** The activity rows of the range by day. */
export async function activityBetween(db: Db, userId: number, first: string, last: string): Promise<Record<string, Row>> {
  const rows = await db.all('SELECT day, steps, active_kcal, distance_m, source FROM activity_day WHERE user_id = ? AND day BETWEEN ? AND ? ORDER BY day',
    [userId, first, last]);
  return Object.fromEntries(rows.map((r) => [r.day, r]));
}

export const workoutsBetween = (db: Db, userId: number, first: string, last: string): Promise<Row[]> =>
  db.all('SELECT * FROM workout WHERE user_id = ? AND day BETWEEN ? AND ? ORDER BY day, COALESCE(started_at, 0), id', [userId, first, last]);

/** The training days in the range (days whose workouts add up to `TRAINING_MIN_MINUTES`), demo rows included. */
export async function trainingDaysBetween(db: Db, userId: number, first: string, last: string): Promise<Set<string>> {
  const rows = await db.all('SELECT day FROM workout WHERE user_id = ? AND day BETWEEN ? AND ? GROUP BY day HAVING SUM(minutes) >= ?',
    [userId, first, last, TRAINING_MIN_MINUTES]);
  return new Set(rows.map((r) => r.day));
}

/** The body weight to estimate with: the latest value up to `day`, else the latest of all, else null. */
export async function weightFor(db: Db, userId: number, day: string): Promise<number | null> {
  const row = (await db.get('SELECT kg FROM weight WHERE user_id = ? AND day <= ? ORDER BY day DESC LIMIT 1', [userId, day]))
    ?? (await db.get('SELECT kg FROM weight WHERE user_id = ? ORDER BY day DESC LIMIT 1', [userId]));
  return row ? row.kg : null;
}
