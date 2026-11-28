// The goal of a user and its history (db.py: get_goal, set_goal, goal_history, goal_timeline, goal_on).
import { DEFAULT_STEPS_GOAL } from '../activity.ts';
import type { Db, Row } from '../db.ts';
import { KEYS, SINCE_START, goalOn as timelineOn, makeTimeline, maskOf, weekdaysOf, type DaySchedule, type GoalValues, type Timeline } from '../goals.ts';

export const DEFAULT_WATER_GOAL = 2000;

/** A row of `goal` or `goal_history` as the API shows a goal (water and steps NULL read as their defaults). */
export const goalOf = (row: Row): GoalValues => ({
  kcal: row.kcal, protein: row.protein, carbs: row.carbs, fat: row.fat,
  water_ml: row.water_ml || DEFAULT_WATER_GOAL, steps: row.steps || DEFAULT_STEPS_GOAL,
});

/** The goal of one weekday schedule as the API shows it: ISO weekdays 1 = Monday ... 7 = Sunday, sorted. */
export interface DaysGoal { weekdays: number[]; kcal: number; protein: number; carbs: number; fat: number }
/** A goal as the settings show it (and as it is saved): the normal goal and, when set, the alternative one for chosen weekdays. */
export type GoalSetting = GoalValues & { days_goal?: DaysGoal };

/** The weekday schedule of a `goal` or `goal_history` row (null when off or incomplete). */
export function scheduleOf(row: Row): DaySchedule | null {
  const days = Number(row.alt_days ?? 0) & 0x7f;
  if (!days || row.alt_kcal == null || row.alt_protein == null || row.alt_carbs == null || row.alt_fat == null) return null;
  return { days, kcal: row.alt_kcal, protein: row.alt_protein, carbs: row.alt_carbs, fat: row.alt_fat };
}
export const daysGoalOf = (s: DaySchedule | null): DaysGoal | null =>
  s ? { weekdays: weekdaysOf(s.days), kcal: s.kcal, protein: s.protein, carbs: s.carbs, fat: s.fat } : null;
export const scheduleFrom = (g: DaysGoal | null | undefined): DaySchedule | null =>
  g ? { days: maskOf(g.weekdays), kcal: g.kcal, protein: g.protein, carbs: g.carbs, fat: g.fat } : null;
/** A row as the settings show it: `days_goal` is there only while a schedule is on (older clients know nothing of it). */
export const settingOf = (row: Row): GoalSetting => {
  const days_goal = daysGoalOf(scheduleOf(row));
  return days_goal ? { ...goalOf(row), days_goal } : goalOf(row);
};

/** The current normal goal (the one that counts from today on, without the weekday schedule). */
export async function getGoal(db: Db, userId: number): Promise<GoalValues | null> {
  const row = await db.get('SELECT kcal, protein, carbs, fat, water_ml, steps FROM goal WHERE user_id = ?', [userId]);
  return row ? goalOf(row) : null;
}

/** The current goal as the settings show it: the normal goal plus the weekday schedule (`days_goal`) when one is on. */
export async function getGoalSetting(db: Db, userId: number): Promise<GoalSetting | null> {
  const row = await db.get('SELECT kcal, protein, carbs, fat, water_ml, steps, alt_days, alt_kcal, alt_protein, alt_carbs, alt_fat FROM goal WHERE user_id = ?', [userId]);
  return row ? settingOf(row) : null;
}

/** The goal changes, newest first: {valid_from, changed_at, ...goal, days_goal?}. Empty without a goal. */
export async function goalHistory(db: Db, userId: number) {
  if (!(await db.get('SELECT 1 FROM goal WHERE user_id = ?', [userId]))) return [];
  const rows = await db.all('SELECT * FROM goal_history WHERE user_id = ? ORDER BY valid_from DESC', [userId]);
  return rows.map((r) => ({ valid_from: r.valid_from as string, changed_at: r.changed_at as number | null, ...settingOf(r) }));
}

/** The goal of every day, null without a goal. A goal without history rows (only a hand-made database) counts as one that always held. */
export async function goalTimeline(db: Db, userId: number): Promise<Timeline | null> {
  const current = await getGoal(db, userId);
  if (current === null) return null;
  const rows = (await db.all('SELECT * FROM goal_history WHERE user_id = ?', [userId]))
    .map((r): [string, GoalValues, DaySchedule | null] => [r.valid_from, Object.fromEntries(KEYS.map((k) => [k, goalOf(r)[k]])) as GoalValues, scheduleOf(r)]);
  if (rows.length) return makeTimeline(rows);
  const row = (await db.get('SELECT * FROM goal WHERE user_id = ?', [userId]))!;
  return makeTimeline([[SINCE_START, current, scheduleOf(row)]]);
}

/** The goal that counted on `day`, null without a goal. */
export async function goalOn(db: Db, userId: number, day: string): Promise<GoalValues | null> {
  const tl = await goalTimeline(db, userId);
  return tl ? timelineOn(tl, day) : null;
}

/** Set the current goal and record it in the history from `validFrom` on (the caller's today). Earlier days keep the goal
 * they had; a second save on the same day overwrites that day's row. Rows from a later day (saved where it was already tomorrow, or a
 * clock that was ahead) go: the goal saved now is the goal from `validFrom` on. `schedule` is the weekday goal: undefined keeps the
 * one saved, null switches it off. */
export async function setGoal(db: Db, userId: number, goal: GoalValues, validFrom: string, changedAt: number, schedule?: DaySchedule | null): Promise<void> {
  await db.tx(async (tx) => {
    const kept = schedule === undefined ? scheduleOf((await tx.get('SELECT alt_days, alt_kcal, alt_protein, alt_carbs, alt_fat FROM goal WHERE user_id = ?', [userId])) ?? {}) : schedule;
    const alt = [kept?.days ?? 0, kept?.kcal ?? null, kept?.protein ?? null, kept?.carbs ?? null, kept?.fat ?? null];
    await tx.run('INSERT INTO goal (user_id, kcal, protein, carbs, fat, water_ml, steps, alt_days, alt_kcal, alt_protein, alt_carbs, alt_fat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(user_id) DO UPDATE SET kcal = excluded.kcal, protein = excluded.protein, carbs = excluded.carbs, '
      + 'fat = excluded.fat, water_ml = excluded.water_ml, steps = excluded.steps, alt_days = excluded.alt_days, alt_kcal = excluded.alt_kcal, '
      + 'alt_protein = excluded.alt_protein, alt_carbs = excluded.alt_carbs, alt_fat = excluded.alt_fat, import_id = NULL',
    [userId, goal.kcal, goal.protein, goal.carbs, goal.fat, goal.water_ml, goal.steps, ...alt]);
    await tx.run('DELETE FROM goal_history WHERE user_id = ? AND valid_from > ?', [userId, validFrom]);
    await tx.run('INSERT INTO goal_history (user_id, valid_from, kcal, protein, carbs, fat, water_ml, steps, changed_at, alt_days, alt_kcal, alt_protein, alt_carbs, alt_fat) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, valid_from) DO UPDATE SET kcal = excluded.kcal, '
      + 'protein = excluded.protein, carbs = excluded.carbs, fat = excluded.fat, water_ml = excluded.water_ml, '
      + 'steps = excluded.steps, changed_at = excluded.changed_at, alt_days = excluded.alt_days, alt_kcal = excluded.alt_kcal, '
      + 'alt_protein = excluded.alt_protein, alt_carbs = excluded.alt_carbs, alt_fat = excluded.alt_fat',
    [userId, validFrom, goal.kcal, goal.protein, goal.carbs, goal.fat, goal.water_ml, goal.steps, changedAt, ...alt]);
  });
}
