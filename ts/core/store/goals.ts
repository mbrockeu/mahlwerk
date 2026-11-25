// The goal of a user and its history (db.py: get_goal, set_goal, goal_history, goal_timeline, goal_on).
import { DEFAULT_STEPS_GOAL } from '../activity.ts';
import type { Db, Row } from '../db.ts';
import { KEYS, SINCE_START, goalOn as timelineOn, makeTimeline, type GoalValues, type Timeline } from '../goals.ts';

export const DEFAULT_WATER_GOAL = 2000;

/** A row of `goal` or `goal_history` as the API shows a goal (water and steps NULL read as their defaults). */
export const goalOf = (row: Row): GoalValues => ({
  kcal: row.kcal, protein: row.protein, carbs: row.carbs, fat: row.fat,
  water_ml: row.water_ml || DEFAULT_WATER_GOAL, steps: row.steps || DEFAULT_STEPS_GOAL,
});

/** The current goal (the one that counts from today on). */
export async function getGoal(db: Db, userId: number): Promise<GoalValues | null> {
  const row = await db.get('SELECT kcal, protein, carbs, fat, water_ml, steps FROM goal WHERE user_id = ?', [userId]);
  return row ? goalOf(row) : null;
}

/** The goal changes, newest first: {valid_from, changed_at, ...goal}. Empty without a goal. */
export async function goalHistory(db: Db, userId: number) {
  if (!(await db.get('SELECT 1 FROM goal WHERE user_id = ?', [userId]))) return [];
  const rows = await db.all('SELECT * FROM goal_history WHERE user_id = ? ORDER BY valid_from DESC', [userId]);
  return rows.map((r) => ({ valid_from: r.valid_from as string, changed_at: r.changed_at as number | null, ...goalOf(r) }));
}

/** The goal of every day, null without a goal. A goal without history rows (only a hand-made database) counts as one that always held. */
export async function goalTimeline(db: Db, userId: number): Promise<Timeline | null> {
  const current = await getGoal(db, userId);
  if (current === null) return null;
  const rows = (await goalHistory(db, userId)).map((r): [string, GoalValues] => [r.valid_from, Object.fromEntries(KEYS.map((k) => [k, r[k]])) as GoalValues]);
  return makeTimeline(rows.length ? rows : [[SINCE_START, current]]);
}

/** The goal that counted on `day`, null without a goal. */
export async function goalOn(db: Db, userId: number, day: string): Promise<GoalValues | null> {
  const tl = await goalTimeline(db, userId);
  return tl ? timelineOn(tl, day) : null;
}

/** Set the current goal and record it in the history from `validFrom` on (the caller's today). Earlier days keep the goal
 * they had; a second save on the same day overwrites that day's row. Rows from a later day (saved where it was already tomorrow, or a
 * clock that was ahead) go: the goal saved now is the goal from `validFrom` on. */
export async function setGoal(db: Db, userId: number, goal: GoalValues, validFrom: string, changedAt: number): Promise<void> {
  const v = [userId, goal.kcal, goal.protein, goal.carbs, goal.fat, goal.water_ml, goal.steps];
  await db.tx(async (tx) => {
    await tx.run('INSERT INTO goal (user_id, kcal, protein, carbs, fat, water_ml, steps) VALUES (?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(user_id) DO UPDATE SET kcal = excluded.kcal, protein = excluded.protein, carbs = excluded.carbs, '
      + 'fat = excluded.fat, water_ml = excluded.water_ml, steps = excluded.steps, import_id = NULL', v);
    await tx.run('DELETE FROM goal_history WHERE user_id = ? AND valid_from > ?', [userId, validFrom]);
    await tx.run('INSERT INTO goal_history (user_id, valid_from, kcal, protein, carbs, fat, water_ml, steps, changed_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, valid_from) DO UPDATE SET kcal = excluded.kcal, '
      + 'protein = excluded.protein, carbs = excluded.carbs, fat = excluded.fat, water_ml = excluded.water_ml, '
      + 'steps = excluded.steps, changed_at = excluded.changed_at',
    [userId, validFrom, goal.kcal, goal.protein, goal.carbs, goal.fat, goal.water_ml, goal.steps, changedAt]);
  });
}
